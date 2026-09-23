import type {
  NormalizedMarketEvent,
  TokenState,
} from "../types/market.js";

function shortMint(mint: string | undefined): string {
  if (!mint) return "unknown";
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

export function formatObserverEvent(
  event: NormalizedMarketEvent,
  state?: TokenState,
): string {
  const title =
    event.kind === "new_token"
      ? "NEW TOKEN"
      : event.kind === "migration"
        ? "MIGRATION"
        : event.kind.toUpperCase();

  const venue =
    state?.chain ??
    state?.platform ??
    state?.pool ??
    state?.source;

  const parts = [
    `[${title}]`,
    state?.symbol ? `${state.symbol}` : undefined,
    shortMint(event.mint),
    venue ? `venue=${venue}` : undefined,
    state?.marketCapSol !== undefined
      ? `MC ${state.marketCapSol.toFixed(2)} SOL`
      : undefined,
    state?.rawEventCount !== undefined
      ? `events=${state.rawEventCount}`
      : undefined,
  ].filter(Boolean);

  return parts.join(" | ");
}
