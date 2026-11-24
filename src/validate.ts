// Eingabeprüfung im Frontend – nur für schnelles Feedback.
// Die verbindliche Prüfung macht das Rust-Backend (runner.rs)!

/** Gibt eine Fehlermeldung zurück oder null, wenn das Ziel gültig ist. */
export function validateTarget(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "Bitte ein Ziel eingeben (IP-Adresse oder Hostname).";
  if (t.length > 253) return "Das Ziel ist zu lang.";
  if (t.startsWith("-") || t.startsWith(".")) return "Das Ziel darf nicht mit '-' oder '.' beginnen.";
  if (!/^[A-Za-z0-9.:-]+$/.test(t)) {
    return "Ungültiges Ziel. Erlaubt sind nur Buchstaben (a–z), Ziffern, Punkt, Bindestrich und Doppelpunkt.";
  }
  return null;
}
