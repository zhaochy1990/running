import { DefaultAzureCredential } from "@azure/identity";
import { odata, TableClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";

const DEFAULT_TABLE_NAME = "strideweeklyplan";

export function parseWeeklyPlanSourceConfig(env) {
  return {
    tableAccountUrl: (env.STRIDE_WEEKLY_PLAN_TABLE_ACCOUNT_URL || "").trim(),
    tableName: (env.STRIDE_WEEKLY_PLAN_TABLE_NAME || "").trim() || DEFAULT_TABLE_NAME,
    blobAccountUrl: (env.STRIDE_CONTENT_BLOB_ACCOUNT_URL || "").trim(),
    container: (
      env.STRIDE_CONTENT_BLOB_CONTAINER || env.STRIDE_CONTENT_CONTAINER || "stride-data"
    ).trim(),
    prefix: (
      env.STRIDE_CONTENT_BLOB_PREFIX ?? env.STRIDE_CONTENT_PREFIX ?? "users"
    ).trim().replace(/^\/+|\/+$/g, ""),
  };
}

export function makeWeeklyPlanSource(config, credential = new DefaultAzureCredential()) {
  if (!config.tableAccountUrl) {
    throw new Error("STRIDE_WEEKLY_PLAN_TABLE_ACCOUNT_URL is required");
  }
  if (!config.blobAccountUrl) {
    throw new Error("STRIDE_CONTENT_BLOB_ACCOUNT_URL is required");
  }
  const table = new TableClient(config.tableAccountUrl, config.tableName, credential);
  const container = new BlobServiceClient(config.blobAccountUrl, credential)
    .getContainerClient(config.container);

  return {
    async listStructured(userId) {
      const entities = [];
      for await (const entity of table.listEntities({
        queryOptions: { filter: odata`PartitionKey eq ${userId} and kind eq ${"plan"}` },
      })) {
        entities.push(entity);
      }
      return entities;
    },

    async listMarkdown(userId) {
      const root = `${config.prefix ? config.prefix + "/" : ""}${userId}/logs/`;
      const blobs = [];
      for await (const item of container.listBlobsFlat({ prefix: root })) {
        const relative = item.name.slice(root.length);
        if (!relative.endsWith("/plan.md")) continue;
        const folder = relative.slice(0, -"/plan.md".length);
        if (!folder || folder.includes("/")) continue;
        blobs.push({
          name: item.name,
          folder,
          lastModified: item.properties?.lastModified ?? null,
        });
      }
      return blobs;
    },

    async readMarkdown(item) {
      return (await container.getBlobClient(item.name).downloadToBuffer()).toString("utf8");
    },
  };
}
