/** "Jana", "Jana and Khaled", "Jana, Khaled and Feky", "Jana, Khaled and 2 others". */
export function peopleLabel(names: string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
