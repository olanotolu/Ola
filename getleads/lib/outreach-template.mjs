export const GM_TOUCH_SUBJECT = "The Best General Manager is in the palm of your hands";

export function buildGmOutreachEmail(firstName = "there") {
  const bodyText = `Hi ${firstName},

When someone calls out 45 minutes before service, does your manager still have to start texting people one by one?

I'm Ola, a Harvard CS student building Concya after talking with hospitality operators around Hilton and Pacha. The same thing kept coming up: managers have 5–10 tools, but the real work still happens in texts, calls, and "who can cover tonight?" panic.

Concya is a manager your team can text.

We're currently in talks with Hilton and Pacha Group — they're rolling out an AI agent that checks in with their employees.

Employees can check in, check out, confirm shifts, call out, and accept coverage from one simple text thread. The manager stays in control, but Concya handles the back-and-forth.

For a 30-person team, even one call-out can turn into 10–20 texts before coverage is solved. If that happens every day, that is hours of manager time every week spent chasing instead of running the house.

We're testing this with hospitality teams now. I'd love to run it for free and show how many texts, calls, and follow-ups Concya can take off your manager's plate.

Worth a 1 min call or video?

Ola`;

  const bodyHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;">
<p style="margin:0 0 16px;">Hi ${firstName},</p>
<p style="margin:0 0 16px;">When someone calls out 45 minutes before service, does your manager still have to start texting people one by one?</p>
<p style="margin:0 0 16px;">I'm Ola, a Harvard CS student building Concya after talking with hospitality operators around Hilton and Pacha. The same thing kept coming up: managers have 5–10 tools, but the real work still happens in texts, calls, and <em>"who can cover tonight?"</em> panic.</p>
<p style="margin:0 0 8px;"><strong>Concya is a manager your team can text.</strong></p>
<p style="margin:0 0 16px;">We're currently in talks with Hilton and Pacha Group — they're rolling out an AI agent that checks in with their employees.</p>
<p style="margin:0 0 16px;">Employees can check in, check out, confirm shifts, call out, and accept coverage from one simple text thread. The manager stays in control, but Concya handles the back-and-forth.</p>
<p style="margin:0 0 16px;">For a 30-person team, even one call-out can turn into <strong>10–20 texts</strong> before coverage is solved. If that happens every day, that is <strong>hours of manager time every week</strong> spent chasing instead of running the house.</p>
<p style="margin:0 0 16px;">We're testing this with hospitality teams now. I'd love to run it <strong>for free</strong> and show how many texts, calls, and follow-ups Concya can take off your manager's plate.</p>
<p style="margin:0 0 16px;">Worth a 1 min call or video?</p>
<p style="margin:0;">Ola</p>
</div>`;

  return { subject: GM_TOUCH_SUBJECT, bodyText, bodyHtml };
}

export const GM_TOUCH2_SUBJECT = `Re: ${GM_TOUCH_SUBJECT}`;

export function buildGmTouch2Email(firstName = "there") {
  const bodyText = `Hi ${firstName},

Following up on my note — we would really love to hear your problems, and the dreams you wish you had solved.

Imagine you had the best general manager in your phone tonight. You could text it five things, and it just does them — or texts you back the answer.

What would those five things be, right now?

We'd love to hear it. Even a quick reply with your list would help us build something that actually fits how you run the house.

And if a one-minute phone call is easier, I would love that too.

Ola`;

  const bodyHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;">
<p style="margin:0 0 16px;">Hi ${firstName},</p>
<p style="margin:0 0 16px;">Following up on my note — we would <strong>really love to hear your problems</strong>, and the dreams you wish you had solved.</p>
<p style="margin:0 0 16px;">Imagine you had the <strong>best general manager in your phone tonight</strong>. You could text it five things, and it just does them — or texts you back the answer.</p>
<p style="margin:0 0 16px;"><strong>What would those five things be, right now?</strong></p>
<p style="margin:0 0 16px;">We'd love to hear it. Even a quick reply with your list would help us build something that actually fits how you run the house.</p>
<p style="margin:0 0 16px;">And if a <strong>one-minute phone call</strong> is easier, I would love that too.</p>
<p style="margin:0;">Ola</p>
</div>`;

  return { subject: GM_TOUCH2_SUBJECT, bodyText, bodyHtml };
}
