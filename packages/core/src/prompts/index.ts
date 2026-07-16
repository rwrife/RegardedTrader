/**
 * Canonical LLM-prompt module (issue #182).
 *
 * Every agent that talks to an LLM sources its SYSTEM prompt and user-message
 * builder from here. See AGENTS.md → "New LLM prompt? Put it in
 * `core/src/prompts/` as a named exported template."
 *
 * Files here MUST stay pure: string constants and pure string-builder
 * functions only. No I/O, no LLM calls, no `any`.
 */
export * as AnalystPrompts from './analyst.js';
export * as TechnicianPrompts from './technician.js';
export * as OptionsStrategistPrompts from './optionsStrategist.js';
export * as TickerValidatorPrompts from './tickerValidator.js';
