export type ConnectionState = 'checking' | 'not_installed_or_not_running' | 'connecting' | 'connected' | 'incompatible_version' | 'connection_blocked' | 'disconnected';
export const SUPPORTED_API_VERSION = 1;
export function versionState(apiVersion: number): ConnectionState { return apiVersion === SUPPORTED_API_VERSION ? 'connected' : 'incompatible_version'; }
export async function failureState(): Promise<ConnectionState> {
  try {
    const permissions = navigator.permissions as Permissions & { query(descriptor: { name: string }): Promise<PermissionStatus> };
    const status = await permissions.query({ name: 'local-network-access' });
    if (status.state === 'denied') return 'connection_blocked';
  } catch { /* unsupported permission API */ }
  return 'not_installed_or_not_running';
}
