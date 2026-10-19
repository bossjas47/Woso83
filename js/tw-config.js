// Shared Tailwind (Play CDN) config for every page. Load right after cdn.tailwindcss.com.
tailwind.config = {
  theme: {
    extend: {
      colors: {
        gallery: '#ffffff', mist: '#f5f5f7', frost: '#fafafc', hairline: '#d6d6d6', control: '#e6e6e8',
        ink: '#1d1d1f', slate: '#6e6e73', steel: '#86868b', appleBlue: '#0066cc', pricingBlue: '#0071e3',
        launchOrange: '#b64400', cyanGlow: '#00e5ff', brandNavy: '#0b1f6b', brandTeal: '#159a9c'
      },
      fontFamily: {
        heading: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'Inter', 'Prompt', 'sans-serif'],
        body: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Inter', 'Prompt', 'sans-serif'],
        mono: ['SF Mono', 'ui-monospace', 'Menlo', 'monospace']
      },
      borderRadius: { card: '28px', links: '10px', pill: '36px', images: '28px', input: '980px', button: '9999px', nav: '20px' }
    }
  }
};
