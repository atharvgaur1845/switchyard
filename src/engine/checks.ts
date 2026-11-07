import { DECISION_CHECKS } from "./decisions.ts";
import { CHECKS as PAYMENT_CHECKS } from "./verifiers.ts";

// Every check a flow's verify step can name: the payment checks
// (verifiers.ts) and the company-decision checks (decisions.ts).
export const CHECKS = { ...PAYMENT_CHECKS, ...DECISION_CHECKS } as typeof PAYMENT_CHECKS;
