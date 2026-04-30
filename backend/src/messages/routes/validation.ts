/**
 * Shared express-validator result → 400 for messages routes.
 */


const { validationResult } = require("express-validator");

function validate(req: { id?: string }, res: { status: (n: number) => { json: (b: unknown) => unknown } }) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

module.exports = { validate };
