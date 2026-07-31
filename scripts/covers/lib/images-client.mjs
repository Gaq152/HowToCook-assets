const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const COMPLETED_TASK_STATUS = new Set(['completed', 'succeeded', 'success']);
const FAILED_TASK_STATUS = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired']);

export class ImageApiError extends Error {
  constructor(message, {
    status = null,
    body = null,
    taskId = null,
    recoverable = false,
  } = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.status = status;
    this.body = body;
    this.taskId = taskId;
    this.recoverable = recoverable;
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

function imageItems(body) {
  if (Array.isArray(body?.data) && body.data.length > 0) return body.data;
  if (Array.isArray(body?.result?.data) && body.result.data.length > 0) return body.result.data;
  return [];
}

async function decodeImage(body, fetchImage) {
  const item = imageItems(body)[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const response = await fetchImage(item.url);
    if (!response.ok) throw new ImageApiError(`下载生成图片失败: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (body?.error) {
    const message = body.error.message || body.message || '图片生成服务返回错误';
    const status = body.error.type === 'internal_error' ? 503 : null;
    throw new ImageApiError(message, { status, body });
  }
  throw new ImageApiError('图片接口响应缺少 data[0].b64_json 或 data[0].url', { body });
}

function taskIdOf(body) {
  return body?.task_id || body?.id || null;
}

function normalizedTaskStatus(body) {
  return String(body?.status || body?.raw_status || '').trim().toLowerCase();
}

function appendImages(form, field, value, defaultFilename) {
  if (value === undefined || value === null) return;
  const values = Array.isArray(value) ? value : [value];
  for (const [index, item] of values.entries()) {
    if (item instanceof Blob) {
      form.append(field, item, item.name || (index === 0 ? defaultFilename : `${index}-${defaultFilename}`));
      continue;
    }
    const bytes = Buffer.isBuffer(item) || item instanceof Uint8Array ? item : item.buffer;
    const filename = item.filename || (index === 0 ? defaultFilename : `${index}-${defaultFilename}`);
    const type = item.type || 'image/png';
    form.append(field, new Blob([bytes], { type }), filename);
  }
}

export class ImagesClient {
  constructor({
    apiKey,
    baseUrl,
    model,
    provider = 'custom',
    asyncMode = false,
    aspectRatio = '1:1',
    responseFormat = null,
    watermark = null,
    fetchImpl = globalThis.fetch,
    maxAttempts = 3,
    timeoutMs = 180000,
    pollIntervalMs = 3000,
    taskTimeoutMs = 900000,
    sleepImpl = sleep,
  }) {
    if (!apiKey) throw new Error('缺少图片接口 API Key');
    if (!baseUrl) throw new Error('缺少图片接口 Base URL');
    if (!model) throw new Error('缺少图片模型名称');
    if (!fetchImpl) throw new Error('当前 Node.js 不支持 fetch');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.provider = provider;
    this.asyncMode = asyncMode;
    this.aspectRatio = aspectRatio;
    this.responseFormat = responseFormat;
    this.watermark = watermark;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.taskTimeoutMs = taskTimeoutMs;
    this.sleepImpl = sleepImpl;
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
      if (error instanceof ImageApiError) throw error;
      throw new ImageApiError(`图片接口网络请求失败: ${error?.message ?? error}`, {
        body: { cause: error?.message ?? String(error) },
      });
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
        const retryable = error instanceof ImageApiError
          && (error.status === null || RETRYABLE_STATUS.has(error.status));
        if (!retryable || attempt === this.maxAttempts) throw error;
        await this.sleepImpl(Math.min(2000 * (2 ** (attempt - 1)), 15000));
      }
    }
    throw lastError;
  }

  authorizationHeaders(contentType = null) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    };
  }

  async downloadResult(body) {
    return decodeImage(body, (url) => this.fetchWithTimeout(url));
  }

  async waitForTask(taskId, { onTaskUpdate = null } = {}) {
    if (!taskId) throw new ImageApiError('异步图片接口响应缺少 task_id', { body: {} });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.taskTimeoutMs) {
      let body;
      try {
        body = await this.request(`/images/tasks/${encodeURIComponent(taskId)}`, () => ({
          method: 'GET',
          headers: this.authorizationHeaders(),
        }));
      } catch (error) {
        if (error instanceof ImageApiError) {
          error.taskId = taskId;
          // 任务已经计费并创建成功；查询失败不应触发一笔新的生图请求。
          error.recoverable = true;
        }
        throw error;
      }
      await onTaskUpdate?.(body);
      const status = normalizedTaskStatus(body);
      if (imageItems(body).length > 0 || COMPLETED_TASK_STATUS.has(status)) {
        return this.downloadResult(body);
      }
      if (FAILED_TASK_STATUS.has(status)) {
        const message = body?.error?.message || body?.message || `图片任务 ${taskId} 执行失败 (${status})`;
        throw new ImageApiError(message, { body, taskId });
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
    throw new ImageApiError(
      `图片任务 ${taskId} 等待超过 ${Math.round(this.taskTimeoutMs / 1000)} 秒，可在下次运行时继续查询`,
      { status: 408, taskId, recoverable: true },
    );
  }

  generationPayload({ prompt, size, quality, n = 1 }) {
    const common = { model: this.model, prompt, n, quality };
    if (this.provider === 'aixoras') {
      return {
        ...common,
        aspect_ratio: this.aspectRatio,
        ...(!this.asyncMode ? { size } : {}),
        response_format: this.responseFormat || 'url',
        watermark: this.watermark ?? false,
      };
    }
    return {
      ...common,
      size,
      ...(this.responseFormat ? { response_format: this.responseFormat } : {}),
    };
  }

  async generate({
    prompt,
    size = '1024x1024',
    quality = 'high',
    n = 1,
    resumeTaskId = null,
    onTaskCreated = null,
    onTaskUpdate = null,
  }) {
    if (resumeTaskId) return this.waitForTask(resumeTaskId, { onTaskUpdate });
    const endpoint = this.asyncMode ? '/images/generations/async' : '/images/generations';
    const body = await this.request(endpoint, () => ({
      method: 'POST',
      headers: this.authorizationHeaders('application/json'),
      body: JSON.stringify(this.generationPayload({ prompt, size, quality, n })),
    }));
    if (imageItems(body).length > 0) return this.downloadResult(body);
    const taskId = taskIdOf(body);
    if (taskId) {
      await onTaskCreated?.({ taskId, body });
      return this.waitForTask(taskId, { onTaskUpdate });
    }
    return this.downloadResult(body);
  }

  async edit({
    image,
    mask = null,
    prompt,
    size = '1024x1024',
    quality = 'high',
    n = 1,
    filename = 'reference.png',
    maskFilename = 'mask.png',
    onTaskCreated = null,
    onTaskUpdate = null,
  }) {
    const form = new FormData();
    form.set('model', this.model);
    form.set('prompt', prompt);
    form.set('n', String(n));
    form.set('quality', quality);
    if (this.provider === 'aixoras') {
      form.set('aspect_ratio', this.aspectRatio);
      form.set('size', size);
      form.set('response_format', this.responseFormat || 'url');
      form.set('watermark', String(this.watermark ?? false));
    } else {
      form.set('size', size);
      if (this.responseFormat) form.set('response_format', this.responseFormat);
    }
    appendImages(form, 'image', image, filename);
    appendImages(form, 'mask', mask, maskFilename);
    const body = await this.request('/images/edits', () => ({
      method: 'POST',
      headers: this.authorizationHeaders(),
      body: form,
    }));
    if (imageItems(body).length > 0) return this.downloadResult(body);
    const taskId = taskIdOf(body);
    if (taskId) {
      await onTaskCreated?.({ taskId, body });
      return this.waitForTask(taskId, { onTaskUpdate });
    }
    return this.downloadResult(body);
  }
}
