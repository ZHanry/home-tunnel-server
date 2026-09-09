import { Router } from "express";
import { z } from "zod";
import { transaction } from "../../db.js";
import { asyncHandler, audit } from "../../http.js";
import { config } from "../../config.js";
import { getPrefixPolicy, parsePrefixPolicy, setPrefixPolicy } from "../../subdomain-policy.js";
import { parseBody } from "../../validation.js";
import { adminGuard } from "./shared.js";
import { clientRawTunnelsEnabled, setClientRawTunnelsEnabled } from "../../client-transports.js";

const router = Router();
const policySchema = z.enum(["off", "suggest", "enforce"]);

router.get(
  "/settings",
  asyncHandler(async (request, response) => {
    adminGuard(request);
    const settings = await transaction(async (client) => ({
      subdomain_prefix_policy: await getPrefixPolicy(client),
      client_raw_tunnels_enabled: await clientRawTunnelsEnabled(client),
    }));
    response.json({
      ...settings,
      default_subdomain_prefix_policy: config.subdomainPrefixPolicy,
      transport_tunnels: {
        tcp: { enabled: config.transportTunnels.tcp.enabled },
        udp: { enabled: config.transportTunnels.udp.enabled },
      },
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
        })
        .refine((value) => Object.keys(value).length > 0),
      request.body,
    );
    const settings = await transaction(async (client) => {
      const before = {
        subdomain_prefix_policy: await getPrefixPolicy(client),
        client_raw_tunnels_enabled: await clientRawTunnelsEnabled(client),
      };
      const policy =
        body.subdomain_prefix_policy === undefined
          ? before.subdomain_prefix_policy
          : parsePrefixPolicy(body.subdomain_prefix_policy);
      if (body.subdomain_prefix_policy !== undefined) await setPrefixPolicy(client, policy);
      if (body.client_raw_tunnels_enabled !== undefined)
        await setClientRawTunnelsEnabled(client, body.client_raw_tunnels_enabled);
      const after = {
        subdomain_prefix_policy: policy,
        client_raw_tunnels_enabled:
          body.client_raw_tunnels_enabled ?? before.client_raw_tunnels_enabled,
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
