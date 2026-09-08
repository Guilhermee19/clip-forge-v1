/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Paleta escura propria, para a UI nao parecer um template padrao.
        ink: {
          950: "#08090d",
          900: "#0d0f15",
          800: "#141722",
          700: "#1d2130",
          600: "#2a3042",
        },
        brand: {
          400: "#5eead4",
          500: "#2dd4bf",
          600: "#14b8a6",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
