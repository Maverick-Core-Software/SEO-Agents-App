export class BudgetExceeded extends Error {
  constructor(message, details = {}) { super(message); this.name = 'BudgetExceeded'; Object.assign(this, details); }
}
export class GenerationInvalid extends Error {
  constructor(message, issues = []) { super(message); this.name = 'GenerationInvalid'; this.issues = issues; }
}
export class ValidationFailed extends Error {
  constructor(message, errors = [], warnings = []) { super(message); this.name = 'ValidationFailed'; this.errors = errors; this.warnings = warnings; }
}
export class LeaseHeld extends Error {
  constructor(message, details = {}) { super(message); this.name = 'LeaseHeld'; Object.assign(this, details); }
}
export class CollectorUnavailable extends Error {
  constructor(message, source = '') { super(message); this.name = 'CollectorUnavailable'; this.source = source; }
}
