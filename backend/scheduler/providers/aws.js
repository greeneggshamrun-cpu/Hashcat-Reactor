'use strict';

/**
 * AWS EC2 GPU provisioning adapter for the cost-aware scheduler.
 *
 * Cost-effective by default:
 *   - SPOT instances (typically 60-90% cheaper than on-demand).
 *   - A GPU instance type from the cheap end (default g4dn.xlarge = 1x T4).
 *   - A Deep Learning Base GPU AMI (driver + CUDA preinstalled) resolved from
 *     AWS's public SSM parameter, so there's no driver-install race and no
 *     software cost beyond the instance itself.
 *   - Instance auto-terminates: InstanceInitiatedShutdownBehavior=terminate plus
 *     the run script's self-destruct shutdown timer.
 *
 * Same safety model as the DigitalOcean adapter:
 *   1. DRY-RUN BY DEFAULT. Real actions need { confirm: true } AND resolvable
 *      AWS credentials. A dry run returns the exact plan and touches nothing.
 *   2. AUTHORIZATION RE-CHECK right before spend.
 *   3. CREDENTIALS VIA THE STANDARD AWS CHAIN ONLY (env vars, shared config,
 *      instance role) — handled by the `aws` CLI. This adapter never accepts a
 *      key as a function/request argument and never logs one.
 *   4. SPEND CONTAINMENT: every resource tagged reactor-scheduler; auto-
 *      terminate; terminateManaged() sweeps leftovers.
 *   5. NO RESULT EXFILTRATION (shared run script writes the potfile locally).
 *
 * How it talks to AWS: it shells out to the `aws` CLI via an injectable exec
 * function (so it unit-tests without AWS or network). The CLI does SigV4 and
 * credential resolution; it must be installed and configured for real actions.
 */

const { execFile } = require('child_process');
const { validateAuthorization } = require('../scheduler');
const { generateRunScript } = require('./runScript');
const { checkJobBudget } = require('../budget');
const { appendAudit, authSnapshot } = require('../audit');

const MANAGED_TAG = 'reactor-scheduler';
// Verified against AWS docs: Deep Learning Base GPU AMI (driver+CUDA), Ubuntu
// 22.04 x86_64, resolvable via this public SSM parameter in each region.
const DEFAULT_AMI_SSM =
  '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id';

/** Default exec: run the aws CLI and parse JSON stdout. Injectable for tests. */
function defaultExec(args, { region } = {}) {
  return new Promise((resolve, reject) => {
    const full = [...args];
    if (region) full.push('--region', region);
    full.push('--output', 'json');
    execFile('aws', full, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`aws ${args[0]} ${args[1] || ''} failed: ${stderr || err.message}`));
      }
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch (_) { json = stdout; }
      resolve(json);
    });
  });
}

class AwsProvisioner {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.exec] injectable (args:string[], {region}) => Promise<any>
   * @param {string}   [opts.region]
   */
  constructor(opts = {}) {
    this.exec = opts.exec || defaultExec;
    this.region = opts.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null;
  }

  _run(args) { return this.exec(args, { region: this.region }); }

  /** Confirm the aws CLI can see working credentials (sts get-caller-identity). */
  async hasCredentials() {
    try {
      const id = await this._run(['sts', 'get-caller-identity']);
      return Boolean(id && (id.Account || id.Arn));
    } catch (_) {
      return false;
    }
  }

  /** Resolve a Deep Learning GPU AMI id from the public SSM parameter. */
  async resolveImage(ssmPath = DEFAULT_AMI_SSM) {
    const res = await this._run(['ssm', 'get-parameters', '--names', ssmPath]);
    const p = res && res.Parameters && res.Parameters[0];
    if (!p || !p.Value) throw new Error(`Could not resolve AMI from SSM path: ${ssmPath}`);
    return p.Value;
  }

  /**
   * Launch one instance. Spot by default (cheapest); set spot:false for
   * on-demand. Returns the created instance summary.
   */
  async runInstance(spec) {
    const tagSpec =
      `ResourceType=instance,Tags=[{Key=Name,Value=${spec.name}},` +
      `{Key=${MANAGED_TAG},Value=true},{Key=basis,Value=${spec.basis || 'unknown'}}]`;
    const args = [
      'ec2', 'run-instances',
      '--image-id', spec.imageId,
      '--instance-type', spec.instanceType,
      '--count', '1',
      '--instance-initiated-shutdown-behavior', 'terminate',
      '--tag-specifications', tagSpec,
      '--user-data', spec.userData,
    ];
    if (spec.keyName) args.push('--key-name', spec.keyName);
    if (spec.securityGroupIds) args.push('--security-group-ids', ...spec.securityGroupIds);
    if (spec.subnetId) args.push('--subnet-id', spec.subnetId);
    if (spec.spot !== false) {
      // One-time spot request, auto-recovered on nothing (hashcat --restore
      // handles interruption). No max price => capped at the on-demand price.
      args.push('--instance-market-options', 'MarketType=spot');
    }
    const res = await this._run(args);
    const inst = res && res.Instances && res.Instances[0];
    return inst
      ? { id: inst.InstanceId, type: inst.InstanceType, state: inst.State && inst.State.Name, spot: spec.spot !== false }
      : null;
  }

  async describeInstance(id) {
    const res = await this._run(['ec2', 'describe-instances', '--instance-ids', id]);
    const r = res && res.Reservations && res.Reservations[0];
    return r && r.Instances && r.Instances[0];
  }

  async terminateInstance(id) {
    await this._run(['ec2', 'terminate-instances', '--instance-ids', id]);
    return { terminated: id };
  }

  async listManaged() {
    const res = await this._run([
      'ec2', 'describe-instances',
      '--filters', `Name=tag:${MANAGED_TAG},Values=true`,
      'Name=instance-state-name,Values=pending,running,stopping,stopped',
    ]);
    const out = [];
    for (const r of (res && res.Reservations) || []) {
      for (const i of r.Instances || []) {
        out.push({ id: i.InstanceId, type: i.InstanceType, state: i.State && i.State.Name });
      }
    }
    return out;
  }

  async terminateManaged() {
    const list = await this.listManaged();
    const ids = list.map((i) => i.id);
    if (ids.length === 0) return { terminated: [] };
    await this._run(['ec2', 'terminate-instances', '--instance-ids', ...ids]);
    return { terminated: ids };
  }
}

/**
 * Plan (and optionally execute) an AWS GPU launch for ONE authorized job.
 *
 * @param {object} job
 * @param {object} options
 * @param {boolean} [options.confirm=false]
 * @param {boolean} [options.spot=true]              spot by default (cheapest)
 * @param {string}  [options.instanceType='g4dn.xlarge']
 * @param {string}  [options.imageId]                explicit AMI; else resolved via SSM
 * @param {string}  [options.amiSsmPath]             override the SSM parameter
 * @param {string}  [options.region]
 * @param {string}  [options.keyName]
 * @param {string[]}[options.securityGroupIds]
 * @param {string}  [options.subnetId]
 * @param {number}  [options.maxLifetimeMinutes=120]
 * @param {AwsProvisioner} [options.provisioner]
 */
async function runAuthorizedJob(job, options = {}) {
  const authErrors = validateAuthorization(job && job.authorization);
  if (authErrors.length) {
    throw new Error(`Refusing to provision: job authorization invalid: ${authErrors.join('; ')}`);
  }

  const spot = options.spot !== false;
  const instanceType = options.instanceType || 'g4dn.xlarge';
  const maxLifetimeMinutes = Number(options.maxLifetimeMinutes) || 120;
  const name = `reactor-${(job.id || 'job')}-${Date.now().toString(36)}`.slice(0, 60);
  // Deep Learning AMI ships CUDA, so default the run script to cudaReady (skip
  // the driver install). Pass cudaReady:false if you deliberately use a bare
  // Ubuntu AMI that needs the driver installed.
  const cudaReady = options.cudaReady != null ? options.cudaReady : true;
  const userData = generateRunScript(job, { maxLifetimeMinutes, cudaReady, ...options });

  const provisioner = options.provisioner || new AwsProvisioner(options);

  // Budget guard. Prefer a modeled estimate; else bound by worst case
  // (hourly price x lifetime) when an hourly rate is supplied.
  const maxUsd = options.maxUsd != null ? options.maxUsd : null;
  const worstCaseUsd = options.instanceUsdPerHour != null
    ? options.instanceUsdPerHour * (maxLifetimeMinutes / 60)
    : null;
  const budget = checkJobBudget({ estimatedUsd: options.estimatedUsd, worstCaseUsd, maxUsd });

  const plan = {
    provider: 'aws',
    action: 'run-instances',
    costModel: spot ? 'spot (cheapest; may be interrupted — hashcat --restore resumes)' : 'on-demand',
    instanceType,
    imageSource: options.imageId ? `explicit ${options.imageId}` : `SSM ${options.amiSsmPath || DEFAULT_AMI_SSM}`,
    region: provisioner.region || '(from AWS config/env)',
    maxLifetimeMinutes,
    autoTerminate: 'InstanceInitiatedShutdownBehavior=terminate + run-script self-destruct',
    budget: { maxUsd, estimatedUsd: options.estimatedUsd != null ? options.estimatedUsd : null, worstCaseUsd, withinBudget: budget.ok, note: budget.ok ? undefined : budget.reason },
    runScript: userData,
    note: 'Dry run. Review the runScript, then re-call with { confirm: true } and configured AWS credentials to launch.',
    willSpend: true,
  };

  const audit = (event, extra) => appendAudit({ event, provider: 'aws', jobId: job.id, name: job.name, authorization: authSnapshot(job), maxUsd, estimatedUsd: options.estimatedUsd != null ? options.estimatedUsd : worstCaseUsd, instanceType, spot, ...extra }, options.auditOpts);

  if (!options.confirm) {
    audit('provision.dryrun', { region: provisioner.region || null });
    return { dryRun: true, plan };
  }
  if (!(await provisioner.hasCredentials())) {
    throw new Error('confirm:true but AWS credentials are not resolvable (configure the aws CLI); refusing to provision');
  }
  if (!budget.ok) {
    audit('provision.refused', { reason: budget.reason });
    throw new Error('Budget cap: ' + budget.reason);
  }

  const imageId = options.imageId || (await provisioner.resolveImage(options.amiSsmPath));
  const instance = await provisioner.runInstance({
    name,
    imageId,
    instanceType,
    userData,
    spot,
    basis: job.authorization.basis,
    keyName: options.keyName,
    securityGroupIds: options.securityGroupIds,
    subnetId: options.subnetId,
  });
  audit('provision.launched', { instanceId: instance && instance.id, imageId });

  return {
    dryRun: false,
    plan: { ...plan, runScript: '<see plan.runScript in a dry run>', imageId },
    instance,
    reminder: 'Instance auto-terminates on shutdown; or terminateInstance(id) / terminateManaged() to sweep. Spot instances can be reclaimed by AWS at any time.',
  };
}

module.exports = {
  AwsProvisioner,
  runAuthorizedJob,
  MANAGED_TAG,
  DEFAULT_AMI_SSM,
};
