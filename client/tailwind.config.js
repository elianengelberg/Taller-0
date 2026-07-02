/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#FFF8F1",
          100: "#FFEEDD",
          200: "#FFDAB3",
          300: "#FFC084",
          400: "#FFA557",
          500: "#FB8A3C",
          600: "#E9701F",
          700: "#C05914",
          800: "#984411",
          900: "#7A3710",
        },
        ink: {
          50: "#F5F4F3",
          100: "#E6E3E0",
          300: "#948B84",
          500: "#584F49",
          700: "#332C26",
          800: "#221D19",
          900: "#14110F",
        },
        sand: {
          50: "#FFFFFF",
          100: "#FAF8F6",
          200: "#F1EDE9",
          300: "#E4DDD6",
          400: "#C9BFB5",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        soft: "0 8px 24px -8px rgba(20, 17, 15, 0.18)",
      },
    },
  },
  plugins: [],
};
