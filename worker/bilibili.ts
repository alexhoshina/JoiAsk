import { MAX_IMAGE_SIZE, rasterExtension, readLimited } from './uploads';
import { canonicalUID } from './identity-shared';

export type Profile = { uid: string; name: string; face: string; signature: string };

type FailureStage = 'http' | 'stale' | 'format' | 'identity';
const restrictedHTTP = new Set([402, 403, 412, 429]);

class ProfileReadError extends Error {
  readonly stage: FailureStage;
  readonly code?: number;
  constructor(stage: FailureStage, code?: number) {
    super('UApiPro profile unavailable');
    this.stage = stage;
    this.code = code;
  }
}

export function profileFailureMessage(error: unknown) {
  const stage = error instanceof ProfileReadError ? error.stage : 'transport';
  const code = error instanceof ProfileReadError ? error.code : undefined;
  // JSON parsing and network errors may include an upstream response or URL.
  // Log only our stage and an optional numeric status.
  console.warn('UApiPro profile unavailable', code === undefined ? { stage } : { stage, code });
  if (stage === 'http' && code !== undefined && restrictedHTTP.has(code)) {
    return 'B 站资料服务 UApiPro 限制了本次请求，请稍后再试';
  }
  if (stage === 'stale') return 'B 站资料服务暂时只返回了过期缓存，请稍后再试';
  return '暂时无法读取 B 站公开资料，请稍后重试';
}

export function parseProfile(json: string, uid: string): Profile {
  let card;
  try {
    card = JSON.parse(json, (key, value, context?: { source?: string }) => {
      // Preserve the original integer literal when a UID exceeds Number.MAX_SAFE_INTEGER.
      if (key === 'mid' && typeof value === 'number') {
        return context?.source ?? (Number.isSafeInteger(value) ? String(value) : null);
      }
      return value;
    });
  } catch {
    throw new ProfileReadError('format');
  }
  if (!card || card.error || typeof card.name !== 'string' || !card.name || typeof card.face !== 'string' ||
      !card.face || typeof card.sign !== 'string') throw new ProfileReadError('format');
  if (card.mid !== uid) throw new ProfileReadError('identity');
  return { uid, name: card.name, face: card.face, signature: card.sign };
}

export async function fetchProfile(uid: string, { freshSince }: { freshSince?: number } = {}): Promise<Profile> {
  if (canonicalUID(uid) !== uid) throw new Error('B 站 UID 无效');
  const endpoint = new URL('https://uapis.cn/api/v1/social/bilibili/userinfo');
  endpoint.searchParams.set('uid', uid);
  // UApiPro caches user profiles for 15 minutes. Its documented REST refresh
  // parameter is needed when a user has just changed their signature.
  if (freshSince !== undefined) endpoint.searchParams.set('_t', String(Date.now()));
  const response = await fetch(endpoint, {
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProfileReadError('http', response.status);
  }
  if (freshSince !== undefined) {
    const cachedSeconds = Number(response.headers.get('Age'));
    const predatesChallenge = cachedSeconds > 0 && Date.now() - cachedSeconds * 1000 < freshSince;
    const markedStale = ['X-Cache-Status', 'EO-Cache-Status'].some(
      header => response.headers.get(header)?.trim().toUpperCase() === 'STALE'
    );
    if (predatesChallenge || markedStale) {
      await response.body?.cancel().catch(() => {});
      throw new ProfileReadError('stale');
    }
  }
  if (!response.body) throw new ProfileReadError('format');
  const bytes = await readLimited(response.body, 1024 * 1024);
  return parseProfile(new TextDecoder().decode(bytes), uid);
}

export async function downloadAvatar(face: string) {
  let url = new URL(face.startsWith('//') ? 'https:' + face : face);
  // Profiles can list an HTTP avatar; all requests, including redirects, must
  // still pass the HTTPS/host checks below before fetching any bytes.
  if (url.protocol === 'http:') url.protocol = 'https:';
  const signal = AbortSignal.timeout(15000);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      (url.hostname !== 'hdslb.com' && !url.hostname.endsWith('.hdslb.com'))) throw new Error('B 站头像地址无效');
    const response = await fetch(url.toString(), { redirect: 'manual', signal });
    const location = response.headers.get('Location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error('下载 B 站头像失败');
    const bytes = await readLimited(response.body, MAX_IMAGE_SIZE);
    const ext = rasterExtension(bytes);
    if (!ext) throw new Error('B 站头像格式无效');
    return { bytes, extension: ext };
  }
  throw new Error('B 站头像重定向过多');
}
