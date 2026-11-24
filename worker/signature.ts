import { ok, fail } from './common';
import { hashPassword, randomHex } from './password.mjs';
import { fetchProfile, profileFailureMessage } from './bilibili';
import { createMemberWithAvatar } from './avatars';
import {
  canonicalUID, conflict, cookieDigest, digestKey, jsonObject, loginSession, publicMember, rateLimit,
  requesterIP, stringField, validMemberPassword, validUsername, withCookie
} from './identity-shared';

type Challenge = {
  digest: string;
  bilibili_uid: string;
  challenge_code: string;
  status: 'pending' | 'verified' | 'consumed';
  requested_at: number;
  expires_at: number;
  verified_at: number | null;
  confirmation_until: number | null;
  bilibili_name: string | null;
  bilibili_avatar: string | null;
};
const ttl = 10 * 60_000;

function present(challenge: Challenge, now = Date.now()) {
  let status: string = challenge.status;
  if ((status === 'pending' && now >= challenge.expires_at) ||
      (status === 'verified' && now >= Number(challenge.confirmation_until))) {
    status = 'expired';
  }
  return {
    status, bilibili_uid: challenge.bilibili_uid,
    requested_at: new Date(challenge.requested_at).toISOString(), expires_at: new Date(challenge.expires_at).toISOString(),
    ...(status === 'pending' && { challenge_code: challenge.challenge_code }),
    ...(status === 'verified' && {
      bilibili_name: challenge.bilibili_name, bilibili_avatar: challenge.bilibili_avatar,
      confirmation_until: new Date(challenge.confirmation_until!).toISOString(),
    }),
  };
}

async function getChallenge(req: Request, env: Env) {
  const digest = await cookieDigest(req, env, 'joi_challenge');
  if (!digest) return null;
  return env.DB.prepare('SELECT * FROM signature_challenges WHERE digest=?').bind(digest).first<Challenge>();
}

export async function signature(req: Request, env: Env, path: string) {
  const method = req.method;
  if (path === '/api/account/verification' && method === 'POST') {
    const body = await jsonObject(req);
    const uid = canonicalUID(body.bilibili_uid);
    if (!uid) return fail(400, 'B 站 UID 无效');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE bilibili_uid=?').bind(uid).first()) return fail(409, '该 B 站 UID 已注册，请直接登录');
    const existing = await getChallenge(req, env);
    if (existing?.bilibili_uid === uid && ['pending', 'verified'].includes(present(existing).status)) return ok(present(existing));
    if (!await rateLimit(env, 'challenge:' + requesterIP(req), 10, 60000)) return fail(429, '请求过于频繁，请稍后重试');
    const raw = randomHex();
    const digest = await digestKey(env, 'joi_challenge', raw);
    const code = 'JoiAsk-' + randomHex(8).toUpperCase();
    const now = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare(`DELETE FROM signature_challenges WHERE
        (status='pending' AND expires_at<=?) OR (status='verified' AND confirmation_until<=?) OR status='consumed'`).bind(now, now),
      env.DB.prepare(`INSERT INTO signature_challenges(digest,bilibili_uid,challenge_code,status,requested_at,expires_at)
        VALUES (?,?,?,'pending',?,?) ON CONFLICT(bilibili_uid) DO NOTHING RETURNING *`).bind(digest, uid, code, now, now + ttl),
    ]);
    const challenge = result[1].results[0] as Challenge | undefined;
    if (!challenge) return fail(409, '该 UID 正在验证中，请稍后再试');
    return withCookie(ok(present(challenge)), req, 'joi_challenge', raw, 2 * ttl / 1000);
  }
  const challenge = await getChallenge(req, env);
  if (!challenge) return fail(404, '没有进行中的验证');
  if (path === '/api/account/verification' && method === 'GET') return ok(present(challenge));
  if (path === '/api/account/verification/check' && method === 'POST') {
    const state = present(challenge);
    if (state.status === 'verified') return ok(state);
    if (state.status !== 'pending') return fail(410, '验证已失效，请重新申请');
    const now = Date.now();
    const gate = await env.DB.prepare(`UPDATE signature_challenges SET next_check=? WHERE digest=?
      AND status='pending' AND expires_at>? AND next_check<=?`).bind(now + 10000, challenge.digest, now, now).run();
    if (!gate.meta.changes) return fail(429, '请稍等十秒后再检查签名');
    let profile;
    try {
      profile = await fetchProfile(challenge.bilibili_uid);
    } catch (error) {
      return fail(502, profileFailureMessage(error));
    }
    if (profile.signature !== challenge.challenge_code) {
      return fail(409, '公开签名与验证码不一致。请将完整签名替换为本次验证码，保存后稍候重试');
    }
    const checkedAt = Date.now();
    const row = await env.DB.prepare(`UPDATE signature_challenges SET status='verified', verified_at=?, confirmation_until=?,
      bilibili_name=?,bilibili_avatar=? WHERE digest=? AND status='pending' AND expires_at>? RETURNING *`)
      .bind(checkedAt, checkedAt + ttl, profile.name, profile.face, challenge.digest, checkedAt).first<Challenge>();
    return row ? ok(present(row)) : fail(410, '验证已失效，请重新申请');
  }
  if (path === '/api/account/register' && method === 'POST') {
    const body = await jsonObject(req);
    const username = stringField(body, 'username').trim();
    const password = stringField(body, 'password');
    if (!validUsername(username)) return fail(400, '登录名需为 2 至 32 个字符且不能包含空格');
    if (!validMemberPassword(password)) return fail(400, '密码至少需要 8 个字符，且不能超过 72 字节');
    if (present(challenge).status !== 'verified') return fail(410, '请先完成有效的签名验证');
    const hash = await hashPassword(password);
    try {
      const user = await createMemberWithAvatar(env, {
        uid: challenge.bilibili_uid,
        username,
        passwordHash: hash,
        name: challenge.bilibili_name!,
        face: challenge.bilibili_avatar!,
        verifiedAt: new Date(challenge.verified_at!).toISOString(),
      }, { challenge: challenge.digest });
      if (!user) return fail(410, '验证已失效或已使用');
      return withCookie(await loginSession(req, env, user, ok(publicMember(user))), req, 'joi_challenge', '', 0);
    } catch (error) {
      if (conflict(error)) return fail(409, '该登录名或 UID 已注册');
      throw error;
    }
  }
  return null;
}
