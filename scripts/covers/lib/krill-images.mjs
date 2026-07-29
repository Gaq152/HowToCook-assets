const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class ImageApiError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.status = status;
    this.body = body;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function parseResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 1000) };
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || `图片接口返回 HTTP ${response.status}`;
    throw new ImageApiError(message, { status: response.status, body });
  }
  return body;
}

async function decodeImage(body, fetchImpl) {
  const item = body?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const response = await fetchImpl(item.url);
    if (!response.ok) throw new ImageApiError(`下载生成图片失败: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new ImageApiError('图片接口响应缺少 data[0].b64_json 或 data[0].url', { body });
}

export class KrillImagesClient {
  constructor({
    apiKey,
    baseUrl = 'https://api.krill-ai.net/v1',
    model = 'gpt-image-2',
    fetchImpl = globalThis.fetch,
    maxAttempts = 3,
    timeoutMs = 180000,
  }) {
    if (!apiKey) throw new Error('缺少 KRILL_AI_API_KEY');
    if (!fetchImpl) throw new Error('当前 Node.js 不支持 fetch');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
  }

  async fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: init.signal ?? controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new ImageApiError(`图片接口请求超过 ${Math.round(this.timeoutMs / 1000)} 秒`, { status: 408 });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async request(path, initFactory) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, initFactory());
        return await parseResponse(response);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ImageApiError && RETRYABLE_STATUS.has(error.status);
        if (!retryable || attempt === this.maxAttempts) throw error;
        await sleep(Math.min(2000 * (2 ** (attempt - 1)), 15000));
      }
    }
    throw lastError;
  }

  async generate({ prompt, size = '1024x1024', quality = 'high' }) {
    const body = await this.request('/images/generations', () => ({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, prompt, size, quality }),
    }));
    return decodeImage(body, this.fetchWithTimeout.bind(this));
  }

}
