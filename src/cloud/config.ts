const DEV_CLOUD_BASE_URL = 'https://dev.rucola.njco.dev';

export function getCloudBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_RUCOLA_CLOUD_URL?.trim();
  return configured || DEV_CLOUD_BASE_URL;
}

export const CLOUD_ENVIRONMENT = 'dev' as const;
