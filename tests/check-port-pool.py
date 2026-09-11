"""Validate the actual merged managed-pool deployment without launching services."""
import json
import subprocess

for base, overlay in (("compose.yaml", "deploy/compose.ports.yaml"),
                      ("deploy/compose.yaml", "deploy/compose.ports.yaml")):
    configuration = json.loads(subprocess.check_output([
        "docker", "compose", "--env-file", ".env.example", "-f", base, "-f", overlay,
        "config", "--format", "json",
    ], text=True))
    control = configuration["services"]["control-center"]["environment"]
    frps = configuration["services"]["frps"]
    assert control["L4_PORT_POOL_ENABLED"] == "true"
    assert control.get("L4_TUNNEL_ENABLED", "false") == "false"
    assert frps["environment"]["L4_TUNNEL_ENABLED"] == "true"
    for key in ("L4_PORT_START", "L4_PORT_END"):
        assert control[key] == frps["environment"][key]
    expected = set(range(int(control["L4_PORT_START"]), int(control["L4_PORT_END"]) + 1))
    assert expected == set(range(10000, 10010))
    for protocol in ("tcp", "udp"):
        actual = set()
        for port in frps["ports"]:
            if port.get("protocol") == protocol and int(port["target"]) in expected:
                assert str(port["published"]) == str(port["target"])
                assert port["host_ip"] == "0.0.0.0"
                actual.add(int(port["target"]))
        assert actual == expected, (base, protocol, actual)
print("Both deployment profiles prepare the same pool for control-center, FRPS and host bindings; console protocols default off")
