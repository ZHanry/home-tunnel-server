import { Router } from "express";
import { z } from "zod";
import { transaction } from "../../db.js";
import { asyncHandler, audit } from "../../http.js";
import { config } from "../../config.js";
import { getPrefixPolicy, parsePrefixPolicy, setPrefixPolicy } from "../../subdomain-policy.js";
import { parseBody } from "../../validation.js";
import { adminGuard } from "./shared.js";
import { clientRawTunnelsEnabled, setClientRawTunnelsEnabled } from "../../client-transports.js";
import {
  transportPatchSchema,
  transportSettingsSummary,
  updateTransportSettings,
} from "../../transport-settings.js";

const router = Router();
const policySchema = z.enum(["off", "suggest", "enforce"]);

router.get(
  "/settings",
  asyncHandler(async (request, response) => {
    adminGuard(request);
    const settings = await transaction(async (client) => ({
      subdomain_prefix_policy: await getPrefixPolicy(client),
      client_raw_tunnels_enabled: await clientRawTunnelsEnabled(client),
      ...(await transportSettingsSummary(client)),
    }));
    response.json({
      ...settings,
      default_subdomain_prefix_policy: config.subdomainPrefixPolicy,
    });
  }),
);

router.patch(
  "/settings",
  asyncHandler(async (request, response) => {
    const actor = adminGuard(request);
    const body = parseBody(
      z
        .object({
          subdomain_prefix_policy: policySchema.optional(),
          client_raw_tunnels_enabled: z.boolean().optional(),
          transport_tunnels: transportPatchSchema.optional(),
          transport_settings_version: z.number().int().min(0).optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.subdomain_prefix_policy !== undefined ||
            value.client_raw_tunnels_enabled !== undefined ||
            value.transport_tunnels !== undefined,
        )
        .refine(
          (value) =>
            value.transport_tunnels === undefined || value.transport_settings_version !== undefined,
          "修改端口设置需要提供当前版本",
        ),
      request.body,
    );
    const settings = await transaction(async (client) => {
      const before = {
        subdomain_prefix_policy: await getPrefixPolicy(client),
        client_raw_tunnels_enabled: await clientRawTunnelsEnabled(client),
        ...(await transportSettingsSummary(client)),
      };
      const policy =
        body.subdomain_prefix_policy === undefined
          ? before.subdomain_prefix_policy
          : parsePrefixPolicy(body.subdomain_prefix_policy);
      if (body.subdomain_prefix_policy !== undefined) await setPrefixPolicy(client, policy);
      if (body.client_raw_tunnels_enabled !== undefined)
        await setClientRawTunnelsEnabled(client, body.client_raw_tunnels_enabled);
      if (body.transport_tunnels !== undefined)
        await updateTransportSettings(
          client,
          body.transport_tunnels,
          body.transport_settings_version!,
        );
      const after = {
        subdomain_prefix_policy: policy,
        client_raw_tunnels_enabled:
          body.client_raw_tunnels_enabled ?? before.client_raw_tunnels_enabled,
        ...(await transportSettingsSummary(client)),
      };
      await audit(
        client,
        request,
        "DeploymentSettingsUpdated",
        "TrafficPolicy",
        actor.userId,
        before,
        after,
      );
      return after;
    });
    response.json(settings);
  }),
);

export { router as settingsRouter };
