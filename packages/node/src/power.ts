/**
 * The power port (M12): the node never asks where it runs — the host
 * tells it. A laptop shell injects a battery-aware source; a server or
 * CLI injects `alwaysPluggedIn`. This keeps @peers/node free of
 * platform APIs while tiered relaying still respects real hardware.
 */
export interface PowerSource {
  /** True when we should NOT spend battery relaying for others. */
  isPowerConstrained(): boolean;
}

/** Desktops, servers, CI: never constrained. */
export const alwaysPluggedIn: PowerSource = {
  isPowerConstrained: () => false,
};
