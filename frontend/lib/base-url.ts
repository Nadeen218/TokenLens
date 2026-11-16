export const base_usrl = (
  process.env.NEXT_PUBLIC_API_URL?.trim() ||
  (process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:8000"
    : "https://back-a8efgycrdeh0a8ht.uaenorth-01.azurewebsites.net")
).replace(/\/+$/, "");
