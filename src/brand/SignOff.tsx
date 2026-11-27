import { APP_HOMEPAGE_URL } from "./homepage.ts";

export interface SignOffProps {
  agentName: string;
  ownerName: string;
}

/** The agent's sign-off, rendered by the core and never written by the model: `— Nova, Sam's AI Agent`. */
export function SignOff({ agentName, ownerName }: SignOffProps) {
  return (
    <span className="sign-off" data-testid="sign-off">
      — {agentName || "Your agent"}, {ownerName || "you"}'s{" "}
      <a href={APP_HOMEPAGE_URL} target="_blank" rel="noreferrer">
        AI Agent
      </a>
    </span>
  );
}
