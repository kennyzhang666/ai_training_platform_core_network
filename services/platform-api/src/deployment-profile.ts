export type DeploymentProfile = 'standard' | 'single-node';

export function deploymentProfile(env: NodeJS.ProcessEnv = process.env): DeploymentProfile {
  const configured = env.PLATFORM_DEPLOYMENT_PROFILE?.trim().toLowerCase().replaceAll('_', '-') || 'standard';
  if (configured !== 'standard' && configured !== 'single-node') {
    throw new Error(`unsupported PLATFORM_DEPLOYMENT_PROFILE: ${configured}`);
  }
  return configured;
}

export function isSingleNodeProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && deploymentProfile(env) === 'single-node';
}
