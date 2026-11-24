import { currentAdmin } from './identity';
import { encryptSecret, fail, ok } from './common';
import { MAX_IMAGE_SIZE, limitedForm, putImage, rasterExtension } from './uploads';

interface Site {
  id: number;
  site_name: string;
  site_description: string;
  logo_url: string;
  favicon_url: string;
  announcement: string;
  custom_css: string;
  email_enabled: number;
  require_verified_user_to_post: number;
}

export interface Settings extends Site {
  settings_version: number;
  ai_base_url: string;
  ai_model: string;
  ai_api_key: string;
  spam_prompt: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: string;
  smtp_username: string;
  smtp_password: string;
  smtp_from_email: string;
  smtp_from_name: string;
  email_site_url: string;
}

export async function publicSiteConfig(env: Env) {
  const site = await env.DB.prepare(`SELECT id,site_name,site_description,logo_url,favicon_url,announcement,
    custom_css,email_enabled,require_verified_user_to_post FROM config WHERE id=1`).first<Site>();
  if (!site) throw new Error('Site configuration missing. Apply D1 migrations.');
  return { ...site, require_verified_user_to_post: !!site.require_verified_user_to_post, email_enabled: !!site.email_enabled };
}

function exposeSettings(row: Settings) {
  return {
    ai_base_url: row.ai_base_url, ai_model: row.ai_model, ai_api_key: '',
    ai_api_key_configured: !!row.ai_api_key, spam_prompt: row.spam_prompt,
    require_verified_user_to_post: !!row.require_verified_user_to_post,
    email: {
      enabled: !!row.email_enabled, host: row.smtp_host, port: row.smtp_port, security: row.smtp_security,
      username: row.smtp_username, password: '', password_configured: !!row.smtp_password,
      from_email: row.smtp_from_email, from_name: row.smtp_from_name, site_url: row.email_site_url,
    },
  };
}

type Fields = Record<string, unknown>;
class Invalid extends Error {}
function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Invalid('请求格式错误');
  return value as Fields;
}
function str(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || value.length > max) throw new Invalid('设置字段格式或长度无效');
  return value;
}
function flag(value: unknown): number {
  if (typeof value !== 'boolean') throw new Invalid('布尔设置无效');
  return Number(value);
}
function webAddress(value: string, httpsOnly = false) {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (!url || !(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) throw new Invalid('请输入有效的网站地址');
  return url.href.replace(/\/+$/, '');
}
function assetAddress(value: unknown) {
  const url = str(value).trim();
  if (!url) return '/favicon.png';
  if (/^\/(?!\/)/.test(url) || /^https?:\/\//i.test(url)) return url;
  throw new Invalid('图片地址需要使用站内路径或 HTTP(S) URL');
}

async function updateSite(env: Env, body: Fields) {
  const values: Record<string, string | number> = {};
  if ('site_name' in body) values.site_name = str(body.site_name, 255).trim() || 'JoiAsk 提问箱';
  if ('site_description' in body) values.site_description = str(body.site_description, 500).trim() || 'JoiAsk 提问箱';
  if ('announcement' in body) values.announcement = str(body.announcement, 65536);
  if ('logo_url' in body) values.logo_url = assetAddress(body.logo_url);
  if ('favicon_url' in body) values.favicon_url = assetAddress(body.favicon_url);
  if ('require_verified_user_to_post' in body) values.require_verified_user_to_post = flag(body.require_verified_user_to_post);
  if ('custom_css' in body) {
    const css = str(body.custom_css, 131072);
    if (/<\/style/i.test(css) || new TextEncoder().encode(css).length > 131072) throw new Invalid('自定义 CSS 格式或大小无效');
    values.custom_css = css;
  }
  const columns = Object.keys(values);
  if (columns.length) {
    await env.DB.prepare('UPDATE config SET ' + columns.map(c => c + '=?').join(',') + ' WHERE id=1')
      .bind(...Object.values(values)).run();
  }
  return ok(await publicSiteConfig(env));
}

async function updateSettings(env: Env, row: Settings, body: Fields) {
  const mail = body.email === undefined ? exposeSettings(row).email : fields(body.email);
  const enabled = flag(mail.enabled);
  const host = str(mail.host, 255).trim().toLowerCase();
  const port = Number(mail.port);
  const security = str(mail.security);
  const username = str(mail.username, 255).trim();
  const from = str(mail.from_email, 254).trim();
  const name = str(mail.from_name, 255).trim();
  const inputURL = str(mail.site_url).trim();
  const siteURL = inputURL ? webAddress(inputURL) : '';
  let password = row.smtp_password;
  if (mail.password === null) password = '';
  else if (mail.password) password = await encryptSecret(str(mail.password, 4096), env.SETTINGS_KEY);
  else if (password && (host !== row.smtp_host || port !== row.smtp_port || username !== row.smtp_username)) {
    throw new Invalid('更改 SMTP 服务器或账号时请重新填写密码');
  }
  if (enabled && (!host || /[\s/:@?#]/.test(host) || !Number.isInteger(port) || port <= 0 || port > 65535 ||
      port === 25 || !['tls', 'starttls'].includes(security) || !siteURL || /[\r\n]/.test(name) ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || (username && !password))) {
    throw new Invalid('请检查 SMTP 主机、端口、加密方式、凭据、发件地址和网站地址');
  }
  const endpoint = webAddress(str(body.ai_base_url ?? row.ai_base_url).trim(), true);
  const model = str(body.ai_model ?? row.ai_model, 255).trim();
  const prompt = str(body.spam_prompt ?? row.spam_prompt, 32768).trim();
  if (!model || !prompt) throw new Invalid('模型和审核提示词不能为空');
  let key = row.ai_api_key;
  if (body.ai_api_key === null) key = '';
  else if (body.ai_api_key) key = await encryptSecret(str(body.ai_api_key, 8192).trim(), env.SETTINGS_KEY);
  else if (key && endpoint !== row.ai_base_url) throw new Invalid('更改 AI 服务地址时请重新填写 API Key');
  const gated = flag(body.require_verified_user_to_post ?? !!row.require_verified_user_to_post);
  const saved = await env.DB.prepare(`UPDATE config SET email_enabled=?, smtp_host=?, smtp_port=?, smtp_security=?, smtp_username=?,
    smtp_password=?, smtp_from_email=?, smtp_from_name=?, email_site_url=?, ai_base_url=?, ai_model=?,
    ai_api_key=?, spam_prompt=?, require_verified_user_to_post=?, settings_version=settings_version+1
    WHERE id=1 AND settings_version=?`)
    .bind(enabled, host, port || 587, security, username, password, from, name, siteURL, endpoint, model, key, prompt, gated, row.settings_version).run();
  if (!saved.meta.changes) throw new Invalid('设置已同时更新，请刷新后再试');
}

async function uploadAsset(req: Request, env: Env) {
  const form = await limitedForm(req, MAX_IMAGE_SIZE + 65536);
  const file = form.get('file');
  if (!(file instanceof File) || !file.size || file.size > MAX_IMAGE_SIZE) return fail(400, '请选择不超过 5 MiB 的图片');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let ext = rasterExtension(bytes);
  if (!ext) {
    const text = new TextDecoder().decode(bytes).trimStart();
    if (/^(?:<\?xml[^>]*\?>\s*)?<svg(?:\s|>)/i.test(text)) ext = '.svg';
    else return fail(400, '仅支持 PNG、JPEG、GIF、WebP 或 SVG 图片');
  }
  return ok({ url: await putImage(env.FILES, 'site-asset-' + crypto.randomUUID() + ext, bytes) });
}

export async function settings(req: Request, env: Env): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!['/api/config', '/api/config/asset', '/api/settings'].includes(path)) return null;
  if (req.method === 'GET' && path === '/api/config') return ok(await publicSiteConfig(env));
  if (!await currentAdmin(req, env)) return fail(408, '请先登录');
  try {
    if (path === '/api/config/asset' && req.method === 'POST') return await uploadAsset(req, env);
    if (path === '/api/config' && req.method === 'PUT') return await updateSite(env, fields(await req.json()));
    if (path === '/api/settings' && ['GET', 'PUT'].includes(req.method)) {
      const load = () => env.DB.prepare('SELECT * FROM config WHERE id=1').first<Settings>();
      const row = await load();
      if (!row) throw new Error('Missing config');
      if (req.method === 'GET') return ok(exposeSettings(row));
      await updateSettings(env, row, fields(await req.json()));
      return ok(exposeSettings((await load())!));
    }
    return fail(405, '请求方法无效');
  } catch (err) {
    if (err instanceof Invalid) return fail(400, err.message);
    if (err instanceof SyntaxError) return fail(400, '请求 JSON 格式错误');
    throw err;
  }
}
