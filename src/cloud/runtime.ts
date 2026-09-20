import { CloudClient } from './CloudClient';
import { getCloudBaseUrl } from './config';

export interface CloudRuntimeStatus {
  environment: 'dev';
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
      environment: 'dev',
      baseUrl,
      reachable: health.ok && health.database,
      service: health.service,
      version: health.version,
    };
  } catch {
    return { environment: 'dev', baseUrl, reachable: false, service: null, version: null };
  }
}
