'use strict';

/**
 * Render a template body for a specific contact.
 * @param {string} body - Template body with {{name}}, {{date}}, {{day}}, {{time}} placeholders
 * @param {Object} contact - { name: string, phone: string }
 * @param {Date} [now] - Optional date override (for testing)
 * @returns {string} Rendered message
 */
function render(body, contact, now = new Date()) {
  const opts = { timeZone: 'Asia/Kolkata' };
  const istDate = new Date(now.toLocaleString('en-US', opts));

  const pad = n => String(n).padStart(2, '0');
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const hour = istDate.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;

  const vars = {
    name: contact?.name || '',
    date: `${istDate.getDate()} ${months[istDate.getMonth()]} ${istDate.getFullYear()}`,
    day: days[istDate.getDay()],
    time: `${hour12}:${pad(istDate.getMinutes())} ${ampm}`,
  };

  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{{${key}}}`);
}

module.exports = { render };
