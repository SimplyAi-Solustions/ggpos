/**
 * The sign-up form's own checks, in the server's words, so a customer is
 * told what to fix before anything is sent. `POST /api/vault/signup` makes
 * the same three checks and is what actually decides.
 */
export interface SignUpErrors {
  name?: string
  email?: string
  terms?: string
}

/** The same broad shape the route accepts; the emailed code proves the rest. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateSignUp(input: {
  name: string
  email: string
  terms: boolean
}): SignUpErrors {
  const errors: SignUpErrors = {}
  if (!input.name.trim()) errors.name = "Add your name."
  else if (input.name.trim().length > 200) errors.name = "Use 200 characters or fewer."
  const email = input.email.trim()
  if (!email) errors.email = "Add your email address. We send the sign-in code there."
  else if (email.length > 254 || !EMAIL_SHAPE.test(email)) {
    errors.email = "That email address does not look right. Check it and try again."
  }
  if (!input.terms) errors.terms = "Accept the terms to join. Read them first if you like."
  return errors
}
