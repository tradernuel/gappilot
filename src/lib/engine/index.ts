export * from "./types";
export {
  calculateSpread,
  calculateSpreadPercent,
  calculateReferenceAge,
  calculateNetOpportunity,
  calculateOpportunityScore,
  estimateSlippage,
  perSharePrice,
  rawToNumber,
  numberToRawCeil,
} from "./calculations";
export { determineActionability, confidenceLevel, isTradFiClosed } from "./actionability";
export { evaluateOpportunity, rankOpportunities, EngineInputError } from "./evaluate";
export * from "./adapters";
export { OpportunityScanner, type ScanOptions, type ScanResult } from "./scanner";
