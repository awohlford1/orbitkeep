import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eventEnvelopeSchema, eventPayloadSchemas, extensionEventPayloadBaseSchema, extensionRecordBaseSchema, recordSchemas, workflowTemplateSchema } from "./core-schemas.ts";
import { relayEnvelopeSchema } from "../../relay/schema.ts";
import { charterSchema } from "../../policy/charter-schema.ts";

/** Materialize registry schemas as package/editor artifacts. Not used at runtime. */
export async function materializeSchemas(root = fileURLToPath(new URL("../../../schemas/1.0/", import.meta.url))): Promise<void> {
  await mkdir(root, { recursive: true });
  await write(root, "event.schema.json", eventEnvelopeSchema);
  await write(root, "config.schema.json", recordSchemas.configuration);
  await write(root, "workflow-template.schema.json", workflowTemplateSchema);
  await write(root, "relay-envelope.schema.json", relayEnvelopeSchema);
  await write(root, "charter.schema.json", charterSchema);
  await write(root, "records/extension-base.schema.json", extensionRecordBaseSchema);
  await write(root, "events/extension-base.schema.json", extensionEventPayloadBaseSchema);
  for (const [name, schema] of Object.entries(recordSchemas)) {
    if (name !== "configuration") await write(root, `records/${name}.schema.json`, schema);
  }
  for (const [name, schema] of Object.entries(eventPayloadSchemas)) await write(root, `events/${name}.schema.json`, schema);
}

async function write(root: string, relative: string, schema: unknown): Promise<void> {
  const destination = new URL(relative.replaceAll("\\", "/"), `file:///${root.replaceAll("\\", "/").replace(/^\//, "")}/`);
  await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
  await writeFile(destination, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await materializeSchemas();
