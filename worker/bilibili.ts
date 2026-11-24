import { MAX_IMAGE_SIZE, rasterExtension, readLimited } from './uploads';
import { canonicalUID } from './identity-shared';

export type Profile = { uid: string; name: string; face: string; signature: string };

export function parseProfile(html: string, uid: string): Profile {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  const end = html.indexOf(';(function(){', start + marker.length);
  if (start < 0 || end < 0) throw new Error('B 站空间数据格式无效');
  // Keep integer UIDs exact even when a JSON number exceeds JS safe integer precision.
  const state = JSON.parse(html.slice(start + marker.length, end), (key, value, context?: { source?: string }) => {
    if (key === 'mid' && typeof value === 'number') {
      return context?.source ?? (Number.isSafeInteger(value) ? String(value) : null);
    }
    return value;
  });
  const info = state?.space?.info;
  if (!info || canonicalUID(info.mid) !== uid || typeof info.name !== 'string' || !info.name
    || typeof info.face !== 'string' || !info.face || typeof info.sign !== 'string') {
    throw new Error('B 站空间身份或资料不完整');
  }
  return { uid, name: info.name, face: info.face, signature: info.sign };
}

export async function fetchProfile(uid: string): Promise<Profile> {
  if (canonicalUID(uid) !== uid) throw new Error('B 站 UID 无效');
  const response = await fetch('https://m.bilibili.com/space/' + uid, {
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    },
  });
  if (!response.ok || !response.body) throw new Error('暂时无法读取 B 站公开空间');
  const bytes = await readLimited(response.body, 10 << 20);
  return parseProfile(new TextDecoder().decode(bytes), uid);
}

export async function downloadAvatar(face: string) {
  let url = new URL(face.startsWith('//') ? 'https:' + face : face);
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
