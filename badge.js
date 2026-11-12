// The accessibility badge, drawn the way Stacki's variables panel draws it:
// a red circled "!" for an error, an amber triangle for a warning. Paths are
// Stacki's own (src/features/variables/FluidBadge.tsx). Colour comes from CSS
// (`color` on the wrapper), so each surface tints it for its own background.

(typeof window !== 'undefined' ? window : globalThis).FT.badgeHtml = (() => {
  const ERROR_PATH =
    'M7.5 0C3.36469 0 0 3.36469 0 7.5C0 11.6353 3.36469 15 7.5 15C11.6353 15 15 ' +
    '11.6353 15 7.5C15 3.36469 11.6353 0 7.5 0ZM6.80063 3.04688C6.80063 2.9175 6' +
    '.90563 2.8125 7.035 2.8125H7.965C8.09438 2.8125 8.19938 2.9175 8.19938 3.04' +
    '688V8.67188C8.19938 8.80125 8.09438 8.90625 7.965 8.90625H7.035C6.90563 8.9' +
    '0625 6.80063 8.80125 6.80063 8.67188V3.04688ZM7.5 12.1875C6.98203 12.1875 6' +
    '.5625 11.768 6.5625 11.25C6.5625 10.732 6.98203 10.3125 7.5 10.3125C8.01797' +
    ' 10.3125 8.4375 10.732 8.4375 11.25C8.4375 11.768 8.01797 12.1875 7.5 12.18' +
    '75Z';

  const WARNING_PATH =
    'M15.8143 12.7909L9.27191 0.764655C8.8929 0.0571658 8.01627 -0.206719 7.3139' +
    '8 0.174664C7.06572 0.309384 6.86215 0.514659 6.72809 0.764655L0.18568 12.79' +
    '09C-0.0705767 13.2559 -0.0609222 13.8231 0.210506 14.2792C0.468694 14.7264 ' +
    '0.943969 15.0011 1.45759 15H14.5424C15.056 15.0011 15.5313 14.7264 15.7895 ' +
    '14.2792C16.0609 13.8231 16.0706 13.2559 15.8143 12.7909ZM8.77649 5.01154L8.' +
    '56272 10.2892C8.55665 10.4381 8.435 10.5556 8.28715 10.5556H7.7134C7.56555 ' +
    '10.5556 7.4439 10.4381 7.43783 10.2892L7.22406 5.01154C7.21771 4.85376 7.34' +
    '295 4.72237 7.49962 4.72237H8.5012C8.65788 4.72237 8.78312 4.85376 8.77677 ' +
    '5.01154H8.77649ZM8 13.3334C7.54293 13.3334 7.17247 12.9603 7.17247 12.5C7.1' +
    '7247 12.0398 7.54293 11.6667 8 11.6667C8.45707 11.6667 8.82753 12.0398 8.82' +
    '753 12.5C8.82753 12.9603 8.45707 13.3334 8 13.3334Z';

  /** Inline SVG for 'error' or 'warning'; an empty string for anything else. */
  return (status) => {
    if (status === 'error') return `<svg viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="${ERROR_PATH}" fill="currentColor"/></svg>`;
    if (status === 'warning') return `<svg viewBox="0 0 16 15" fill="none" aria-hidden="true"><path d="${WARNING_PATH}" fill="currentColor"/></svg>`;
    return '';
  };
})();
