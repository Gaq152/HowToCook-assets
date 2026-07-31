import { ImagesClient } from './images-client.mjs';

export { ImageApiError, ImagesClient } from './images-client.mjs';

// 保留旧导出，避免已有脚本或测试立即失效。
export class KrillImagesClient extends ImagesClient {
  constructor(options = {}) {
    super({
      baseUrl: 'https://api.krill-ai.net/v1',
      model: 'gpt-image-2',
      ...options,
      provider: 'krill',
    });
  }
}
