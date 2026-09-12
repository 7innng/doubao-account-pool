import type { ApiRequest } from "./types.js";

export function toPublicApiRequest(request: ApiRequest) {
  return {
    requestId: request.requestId,
    status: request.status,
    message: request.message,
    model: request.model,
    referenceImageCount: request.referenceImagePaths.length,
    cleanVideoUrl: request.cleanVideoUrl,
    outputVideoPath: request.outputVideoPath,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    finishedAt: request.finishedAt
  };
}
