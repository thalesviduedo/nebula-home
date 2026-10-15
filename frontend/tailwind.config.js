/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1280px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /* ---- Obsidian Telemetry (design system do Stitch) ----
         * Nomes idênticos aos usados nas telas geradas, para o markup
         * portar direto: bg-surface-container-low, text-on-surface-variant,
         * text-tertiary, …
         */
        surface: {
          DEFAULT: "#0f131c",
          dim: "#0f131c",
          bright: "#353943",
          variant: "#31353f",
          tint: "#4cd7f6",
          container: {
            DEFAULT: "#1c1f29",
            low: "#181b25",
            lowest: "#0a0e17",
            high: "#262a34",
            highest: "#31353f",
          },
        },
        "on-surface": {
          DEFAULT: "#dfe2ef",
          variant: "#bcc9cd",
        },
        "on-background": "#dfe2ef",
        "inverse-surface": "#dfe2ef",
        "inverse-primary": "#00687a",
        "primary-container": "#06b6d4",
        "on-primary": "#003640",
        "on-primary-container": "#00424f",
        "primary-fixed": "#acedff",
        "primary-fixed-dim": "#4cd7f6",
        "secondary-container": "#00a572",
        "on-secondary": "#003824",
        "on-secondary-container": "#00311f",
        "secondary-fixed": "#6ffbbe",
        "secondary-fixed-dim": "#4edea3",
        tertiary: "#ffb95f",
        "tertiary-container": "#e79400",
        "on-tertiary": "#472a00",
        "on-tertiary-container": "#563400",
        "tertiary-fixed": "#ffddb8",
        error: "#ffb4ab",
        "on-error": "#690005",
        "error-container": "#93000a",
        "on-error-container": "#ffdad6",
        outline: "#869397",
        "outline-variant": "#3d494c",
        /* paleta Nebula (legado) */
        abyss: "#05070f",
        panel: "#141c30",
        neon: "hsl(var(--primary))",
        magenta: "#ff2fd6",
        mint: "#4edea3",
        danger: "hsl(var(--destructive))",
        warn: "#ffb95f",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        shimmer: { to: { backgroundPosition: "-200% 0" } },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        shimmer: "shimmer 1.2s infinite",
      },
    },
  },
  plugins: [],
};
