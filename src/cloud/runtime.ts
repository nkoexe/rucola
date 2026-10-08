import { CloudClient, CloudClientError } from './CloudClient';
import { getCloudBaseUrl } from './config';

export interface CloudRuntimeStatus {
  environment: 'production';
  baseUrl: string;
  reachable: boolean;
  service: string | null;
  version: string | null;
}

export async function checkCloudRuntime(): Promise<CloudRuntimeStatus> {
  const baseUrl = getCloudBaseUrl();
  const client = new CloudClient({ baseUrl });
  try {
    const health = await client.health();
    return {
      environment: 'production',
      baseUrl,
      reachable: health.ok && health.database,
      service: health.service,
      version: health.version,
    };
  } catch (cause) {
    if (cause instanceof Error) {
      console.warn(
        `[rucola] production cloud health check failed: ${cause.name}: ${cause.message}`,
      );
    } else {
      console.warn('[rucola] production cloud health check failed: unknown error');
    }
    return { environment: 'production', baseUrl, reachable: false, service: null, version: null };
  }
}
