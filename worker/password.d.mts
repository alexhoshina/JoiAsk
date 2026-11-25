export function randomHex(bytes?: number): string;
export function validInitialAdminCredentials(username: unknown, password: unknown): boolean;
export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, stored: string): Promise<boolean>;
