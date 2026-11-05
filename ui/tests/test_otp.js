const assert = require("assert")
const { load, deepEqual } = require("./load")

const otp = load("message/Otp.js")

function code(subject, body) {
  const found = otp.detect(subject, body)
  return found ? found.code : null
}

// ------------------------------------------------------------- sign-in mail

assert.strictEqual(code("[GitHub] Please verify your device",
  "Hey reader!\n\nA sign in attempt requires further verification because we did not recognize your device."
  + " To complete the sign in, enter the verification code on the unrecognized device.\n\n"
  + "Device: Firefox on Linux\nVerification code: 482913\n\n"
  + "If you did not attempt to sign in to your account, your password may be compromised."),
  "482913")

assert.strictEqual(code("Your Microsoft account security code",
  "Please use the following security code for the Microsoft account re***@example.com.\n\n"
  + "Security code: 7140385\n\nIf you don't recognize the Microsoft account, you can click here to remove your email address."),
  "7140385")

// The code set out on a line of its own, under the line that names it.
assert.strictEqual(code("Verify your Apple Account email address",
  "To verify your email address, enter this code in your browser.\n\n591 204\n\n"
  + "This code will expire three hours after this email was sent."),
  "591204")

assert.strictEqual(code("Your Stripe verification code", "Your Stripe verification code is: 228-731"),
  "228731")
deepEqual(otp.detect("", "Your one-time passcode is 228-731"), { code: "228731", display: "228 731" },
  "the sender's grouping is kept for display and removed for the clipboard")

// Code first, name after: one common phrasing puts the words behind it.
assert.strictEqual(code("", "123987 is your Instagram code. Don't share it."), "123987")

// Only the subject carries it, which some senders do and nothing more.
assert.strictEqual(code("Your login code: 6172", ""), "6172")

assert.strictEqual(code("Sign in to Slack", "Your confirmation code is below\n\nQX7-4KP\n\n"), null,
  "a split word-like code is not a format this reads")
assert.strictEqual(code("Your sign-in code", "Use this one-time code to sign in:\n\nK7Q2ZP\n"), "K7Q2ZP")

// G- is Google's prefix for a typed code, not part of what is typed.
assert.strictEqual(code("", "G-482913 is your Google verification code."), "482913")

// The subject and the body agree, which is one code, not two.
assert.strictEqual(code("482913 is your verification code", "Your verification code is 482913."), "482913")

// Non-breaking spaces between the groups are still one code.
assert.strictEqual(code("", "Verification code: 591 204"), "591204")

// Other languages compound the word, so it is matched inside them.
assert.strictEqual(code("Ihr Bestätigungscode", "Ihr Bestätigungscode lautet: 830412"), "830412")

// ---------------------------------------------------- not a sign-in code

assert.strictEqual(code("Summer sale ends tonight", "Take 20% off everything. Use code SUMMER20 at checkout."), null)
assert.strictEqual(code("A gift for you", "Your promo code: 4821 gets you free shipping"), null)
assert.strictEqual(code("Your order has shipped",
  "Order number: 1129384\nTracking code: 9400111202555842\nThanks for shopping."), null)
assert.strictEqual(code("Receipt", "Receipt #48211\nTotal $1234.00\nAuthorization code applied 2026"), null)
assert.strictEqual(code("Your booking is confirmed", "Booking reference code: K7Q2ZP\nFlight 2231 departs 14:05."), null)
assert.strictEqual(code("Meeting notes", "See you on 2026-11-06 at 14:30. Room 4410."), null,
  "no word says any of these is a code")
assert.strictEqual(code("Re: dinner", "The code for the gate is 2024? No, it changed in 2025."), null,
  "years are not codes")
assert.strictEqual(code("Security alert", "We noticed a new sign-in.\nCall 555-123-4567 if this wasn't you."), null)
assert.strictEqual(code("", "Your code is https://example.com/verify?code=482913"), null,
  "a code inside a link is the link's")
assert.strictEqual(code("", "Your code costs $4821.50 this month"), null)
assert.strictEqual(code("", "Verify with code 1234.5678"), null, "a decimal is not a code")
assert.strictEqual(code("", "Login on 12/04/2026 at 10:15"), null)
assert.strictEqual(code("", ""), null)
assert.strictEqual(code(null, undefined), null)

assert.strictEqual(code("Summer sale", "Take 20% off. Use code SUMMER20 or 482913 at checkout."), null,
  "a promotion's numbers, a sentence after the discount")

// Two different codes in one message is a question, not an answer.
assert.strictEqual(code("Your verification codes",
  "Verification code for desktop: 482913\nVerification code for mobile: 771204"), null)

// A word-like candidate needs stronger words than "code".
assert.strictEqual(code("", "Your code: AB12CD"), null)

// The scan is bounded: a code past the limit is not looked for.
assert.strictEqual(code("", new Array(otp.MAX_SCAN + 10).join(" ") + "Verification code: 482913"), null)


// ------------------------------------- found in review: words that are not codes

assert.strictEqual(code("", "Login ID 88412233"), null)
assert.strictEqual(code("", "Your security deposit of 1500 is due"), null)
assert.strictEqual(code("Security notice", "Security notice: your account 12345678 was accessed"), null)
assert.strictEqual(code("", "Read our security policy, effective 2026. Call 0800 123 4567"), null)
assert.strictEqual(code("", "Security Team\n1600 Amphitheatre Parkway"), null)
assert.strictEqual(code("", "Log in to view your statement.\n\n12345 Main Street"), null)
assert.strictEqual(code("", "Your token expires at 1630 UTC"), null)
assert.strictEqual(code("New sign-in", "Login from New York, NY 10001"), null)

// --------------------------- found in review: real codes beside other numbers

assert.strictEqual(code("", "Your verification code is 482913. It expires at 1530."), "482913")
assert.strictEqual(code("", "Your code is 482913 and expires in 10 minutes. Account 99887766."), "482913")
assert.strictEqual(code("", "OTP for txn of INR 5000 is 482913. Do not share it with anyone."), "482913")
assert.strictEqual(code("", "Your verification code is 123456. Do not share. Get 10% off your next order."), "123456")
// A code in the range of years, named right before it.
assert.strictEqual(code("", "Your login code: 1999"), "1999")
assert.strictEqual(code("", "Your PIN is 2024"), "2024")

// ---------------------------------------------------------------- copyable

assert.strictEqual(otp.copyable("482913"), true)
assert.strictEqual(otp.copyable("K7Q2ZP"), true)
assert.strictEqual(otp.copyable("-482913"), false)
assert.strictEqual(otp.copyable("48 29"), false)
assert.strictEqual(otp.copyable(""), false)
assert.strictEqual(otp.copyable(undefined), false)

// ------------------------------------------------------------------- fresh

const now = Date.UTC(2026, 10, 6, 12, 0, 0)
assert.strictEqual(otp.fresh(new Date(now - 60 * 1000), now), true)
assert.strictEqual(otp.fresh(new Date(now - 14 * 60 * 1000).toISOString(), now), true,
  "a summary that crossed the backend carries its date as text")
assert.strictEqual(otp.fresh(now - 16 * 60 * 1000, now), false, "an old code is being read, not used")
assert.strictEqual(otp.fresh(now + 2 * 60 * 1000, now), true, "a sender's clock a little ahead")
assert.strictEqual(otp.fresh(now + 60 * 60 * 1000, now), false)
assert.strictEqual(otp.fresh(null, now), false)
assert.strictEqual(otp.fresh("not a date", now), false)

console.log("otp: ok")
