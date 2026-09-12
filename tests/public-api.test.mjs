import assert from "node:assert/strict";
import test from "node:test";

import { toPublicApiRequest } from "../dist-electron/public-api.js";

test("returns an MP4-suffixed source hint and authenticated MP4 API path", () => {
  const result = toPublicApiRequest({
    requestId: "dola-test123",
    status: "success",
    message: "done",
    model: "seedance_2_5",
    referenceImagePaths: [],
    creditCost: 2,
    creditRefunded: false,
    cleanVideoUrl: "https://cdn.example.com/download?id=1&token=signed",
    outputVideoPath: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:01.000Z",
    finishedAt: "2026-09-12T00:00:01.000Z"
  });

  assert.equal(result.cleanVideoUrl, "https://cdn.example.com/download?id=1&token=signed#video.mp4");
  assert.equal(result.videoUrl, "/api/requests/dola-test123/video.mp4");
});
