import packageJson from '../../package.json';

interface RuntimeEnvLike {
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  APP_GIT_SHA?: string;
  APP_BUILD_TIME?: string;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveRuntimeEnvironment(env?: RuntimeEnvLike | null): string {
  return (
    cleanString(env?.ENVIRONMENT) ||
    cleanString(env?.NODE_ENV) ||
    cleanString(process.env.ENVIRONMENT) ||
    cleanString(process.env.NODE_ENV) ||
    'development'
  );
}

export function resolveDiagnosticRuntime(env?: RuntimeEnvLike | null): {
  environment: string;
  isDevelopment: boolean;
  devTaggedAsProduction: boolean;
} {
  const source = env ?? process.env;
  // The diagnostic environment tag comes from ENVIRONMENT alone — never NODE_ENV.
  // The Docker images bake in NODE_ENV=production (docker/app, docker/worker),
  // so a NODE_ENV fallback would tag every compose/local stack that omits
  // ENVIRONMENT as "production" and pollute the production diagnostic stream.
  // An explicitly supplied snapshot is authoritative. Falling through from a
  // partial snapshot to the host process made callers depend on an unrelated
  // shell ENVIRONMENT value.
  const declaredEnvironment = cleanString(source.ENVIRONMENT) || 'development';
  const nodeEnvironment = cleanString(source.NODE_ENV);
  const devTaggedAsProduction =
    nodeEnvironment === 'development' && declaredEnvironment === 'production';
  const environment = devTaggedAsProduction
    ? 'development'
    : declaredEnvironment;

  return {
    environment,
    isDevelopment:
      nodeEnvironment === 'development' || environment === 'development',
    devTaggedAsProduction,
  };
}

export function getRuntimeInfo(env?: RuntimeEnvLike | null) {
  return {
    version: packageJson.version,
    revision:
      cleanString(env?.APP_GIT_SHA) ||
      cleanString(process.env.APP_GIT_SHA) ||
      'unknown',
    build_time:
      cleanString(env?.APP_BUILD_TIME) ||
      cleanString(process.env.APP_BUILD_TIME) ||
      null,
    environment: resolveRuntimeEnvironment(env),
  };
}
