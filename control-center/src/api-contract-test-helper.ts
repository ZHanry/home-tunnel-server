import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const spec = JSON.parse(
  readFileSync(new URL("../../contracts/openapi.v1.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: "home-tunnel-api", components: spec.components });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export function validateApiResponse(method: string, path: string, status: number, data: unknown) {
  const pathname = path.split("?")[0]!;
  const entry = spec.paths[pathname]
    ? [pathname, spec.paths[pathname]]
    : Object.entries(spec.paths).find(([pattern]) =>
        new RegExp(`^${pattern.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname),
      );
  assert.ok(entry, `Undocumented route ${method} ${path}`);
  const operations = entry[1] as Record<
    string,
    { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }
  >;
  const operation = operations[method.toLowerCase()];
  assert.ok(operation, `Undocumented method ${method} ${path}`);
  const response = operation.responses[String(status)];
  assert.ok(response, `Undocumented status ${status} for ${method} ${path}`);
  const schema = response.content?.["application/json"]?.schema;
  if (!schema) return;
  const key = `${method}:${entry[0]}:${status}`;
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(
      JSON.parse(
        JSON.stringify(schema).replaceAll('"#/components/', '"home-tunnel-api#/components/'),
      ),
    );
    validators.set(key, validate);
  }
  assert.ok(validate(data), `${key}: ${JSON.stringify(validate.errors)}`);
}
