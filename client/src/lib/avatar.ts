// Utilidades de la foto de perfil.

// Iniciales para cuando no hay foto: "Juan Pablo Nora" -> "JN". Se toman la
// primera y la última palabra, que es lo que la gente reconoce; con una sola
// palabra, su primera letra.
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

// Color de fondo estable por persona: el mismo nombre da siempre el mismo
// color, así la burbuja de subtítulos de alguien es reconocible de un vistazo
// aunque no tenga foto. Tonos elegidos para que el texto blanco encima
// mantenga contraste suficiente.
const AVATAR_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#c026d3",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#0284c7",
];

export function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Lado del cuadrado final. Suficiente para pantallas retina sin pesar. */
const AVATAR_SIZE = 256;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

export interface PreparedAvatar {
  blob: Blob;
  /** URL local para previsualizarla antes de subir. Hay que revocarla. */
  previewUrl: string;
}

/**
 * Deja la foto lista para subir: la recorta al cuadrado central y la reduce a
 * 256x256 JPEG.
 *
 * Se hace en el navegador a propósito. La gente sube fotos de 4000px y 8 MB
 * sacadas con el celular; mandarlas tal cual sería una subida lenta con datos
 * móviles, un archivo caro de servir en cada reunión, y un servidor teniendo
 * que procesar imágenes. Acá queda en ~20 KB antes de salir del dispositivo.
 */
export async function prepareAvatar(file: File): Promise<PreparedAvatar> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Ese archivo no es una imagen. Elegí una foto (JPG, PNG o WEBP).");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("La imagen es demasiado grande. Probá con una de menos de 12 MB.");
  }

  const bitmap = await loadImage(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Este navegador no pudo procesar la imagen.");

    // Recorte cuadrado centrado: una foto apaisada o vertical se recorta a sus
    // lados en vez de deformarse.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
    if (!blob) throw new Error("No se pudo preparar la imagen.");
    return { blob, previewUrl: URL.createObjectURL(blob) };
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

// createImageBitmap es lo directo, pero Safari viejo no lo tiene para File;
// ahí se cae a un <img> con object URL, que sí funciona en todos lados.
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // formato que el decodificador rápido no soporta -- seguimos abajo
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("No pudimos abrir esa imagen."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
