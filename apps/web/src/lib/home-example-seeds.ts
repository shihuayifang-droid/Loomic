export type InputMention = {
  /** "image" = reference image to attach; "tool" = model/tool selector (informational only) */
  type: "image" | "tool";
  /** Display name shown in the @mention capsule */
  name: string;
  /** Image URL (thumbnail for images, icon for tools) */
  imgSrc: string;
};

export type HomeExampleCard = {
  title: string;
  prompt: string;
  /** Images shown on the preview card (generated output images, display only) */
  previewImages: string[];
  /** @mention items from the original Lovart input (images = actual inputs, tools = informational) */
  inputMentions: InputMention[];
};

export type HomeExampleCategory = {
  key: string;
  label: string;
  dataType: string;
  accent?: "special";
  examples: HomeExampleCard[];
};

export type HomeExampleSelection = {
  categoryKey: string;
  categoryLabel: string;
  title: string;
  prompt: string;
  previewImages: string[];
  inputMentions: InputMention[];
};

// ---------------------------------------------------------------------------
// Seed URLs live in their own public bucket (X-52 prep)
// ---------------------------------------------------------------------------

/**
 * These seed images used to sit in the USER asset bucket (`project-assets`),
 * alongside real project files, and the fallbacks below hard-coded those public
 * URLs. X-52 has to make that bucket private — which would 403 every anonymous
 * home-page, example and discovery request at once. So the seeds move to a bucket
 * of their own, and every URL these modules emit is projected onto it.
 *
 * The literals below are written as `legacySeed(key)` instead of a full URL: the
 * key is the part that never changes, and which bucket serves it is a decision
 * this file owns. It also means a seed cannot quietly point back at the user
 * bucket — only the projection's output is ever exported.
 */
const SEED_ORIGIN = "https://jmcrxgenontlkxktpihl.supabase.co";
const PUBLIC_OBJECT_PATH = "/storage/v1/object/public/";
/** The user asset bucket that held the seeds until the migration ran. */
const LEGACY_ASSET_BUCKET = "project-assets";
/** Public bucket created for seeds only (migration 20261002000001). */
export const HOME_SEEDS_BUCKET = "home-seeds";
/** Key prefix the seeds used to sit under inside the user bucket. */
const LEGACY_SEED_PREFIX = `${HOME_SEEDS_BUCKET}/`;

/**
 * Build the pre-migration public URL for a seed key.
 *
 * Exported only so the sibling discovery module can share the helper; the value
 * it returns is never rendered — it always goes through `toHomeSeedsPublicUrl`
 * on the way out (see the projection at the end of this file, and the one in
 * home-discovery-seeds.ts).
 */
export function legacySeed(key: string): string {
  return `${SEED_ORIGIN}${PUBLIC_OBJECT_PATH}${LEGACY_ASSET_BUCKET}/${LEGACY_SEED_PREFIX}${key}`;
}

/**
 * Project a seed URL onto the dedicated public bucket.
 *
 * Pure, and deliberately narrow: only the EXACT public seed prefix in the user
 * bucket is rewritten. A different bucket, a different prefix in the same bucket,
 * a signed URL or a plain link all come back byte-for-byte unchanged.
 */
export function toHomeSeedsPublicUrl(url: string): string {
  const from = `${SEED_ORIGIN}${PUBLIC_OBJECT_PATH}${LEGACY_ASSET_BUCKET}/${LEGACY_SEED_PREFIX}`;
  const to = `${SEED_ORIGIN}${PUBLIC_OBJECT_PATH}${HOME_SEEDS_BUCKET}/`;
  return url.split(from).join(to);
}

function projectCard(card: HomeExampleCard): HomeExampleCard {
  return {
    ...card,
    previewImages: card.previewImages.map(toHomeSeedsPublicUrl),
    inputMentions: card.inputMentions.map((mention) => ({
      ...mention,
      imgSrc: toHomeSeedsPublicUrl(mention.imgSrc),
    })),
  };
}

function projectCategory(category: HomeExampleCategory): HomeExampleCategory {
  return { ...category, examples: category.examples.map(projectCard) };
}

function ex(
  title: string,
  prompt: string,
  previewImages: string[],
  inputMentions: InputMention[],
): HomeExampleCard {
  return { title, prompt, previewImages, inputMentions };
}

function cat(
  key: string,
  label: string,
  dataType: string,
  examples: HomeExampleCard[],
  accent?: "special",
): HomeExampleCategory {
  return { key, label, dataType, examples, ...(accent ? { accent } : {}) };
}

function img(name: string, imgSrc: string): InputMention {
  return { type: "image", name, imgSrc };
}

function tool(name: string, imgSrc: string): InputMention {
  return { type: "tool", name, imgSrc };
}

/**
 * Seed data mirrored from Lovart's top-of-home quick-start cases.
 * Keep this in code for now so prompts and image assets are easy to swap later.
 */
/** Unprojected seed data. Not exported — consume `homeExampleSeedCategories`. */
const rawHomeExampleSeedCategories: HomeExampleCategory[] = [
  cat("nano-banana-pro", "Nano Banana Pro", "Special", [
    ex(
      "Design pixel-perfect web interface.",
      "Generate a landing page for a furniture shop called Loomic, Neo Brutalism style. These are the product images:",
      [
        legacySeed("examples/nano-banana-pro/e1-1.webp"),
        legacySeed("examples/nano-banana-pro/e1-2.webp"),
        legacySeed("examples/nano-banana-pro/e1-3.webp"),
      ],
      [
        tool("Nano Banana Pro", legacySeed("icons/imagen-3.svg")),
        img("Chair", legacySeed("inputs/nano-banana-pro/e1-input-1.webp")),
        img("Nightstand", legacySeed("inputs/nano-banana-pro/e1-input-2.webp")),
        img("Beanbag", legacySeed("inputs/nano-banana-pro/e1-input-3.webp")),
        img("Table", legacySeed("inputs/nano-banana-pro/e1-input-4.webp")),
        img("Stool", legacySeed("inputs/nano-banana-pro/e1-input-5.webp")),
      ],
    ),
    ex(
      "Solve a complex math problem on the white board.",
      "Generate an image of an undergraduate level math problem and solution written on a white board.",
      [
        legacySeed("examples/nano-banana-pro/e2-1.webp"),
        legacySeed("examples/nano-banana-pro/e2-2.webp"),
        legacySeed("examples/nano-banana-pro/e2-3.webp"),
      ],
      [
        tool("Nano Banana Pro", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Make a classic superhero comic strip.",
      "A vintage 1970s comic book page depicting a multi-panel superhero story sequence. The art style is classic hand-drawn comic illustration with bold outlines and a vibrant but slightly faded color palette, including visible Ben-Day dots. The comic strip features Wonder Woman in her iconic costume, alongside two men in suits, set against the backdrop of New York City. The narrative shows Wonder Woman rescuing the men from their boring 9-to-5 office jobs. The page is laid out in a traditional comic panel grid, complete with speech bubbles, narration boxes, creating a nostalgic, adventurous, and quirky retro feel.",
      [
        legacySeed("examples/nano-banana-pro/e3-1.webp"),
        legacySeed("examples/nano-banana-pro/e3-2.webp"),
        legacySeed("examples/nano-banana-pro/e3-3.webp"),
      ],
      [
        tool("Nano Banana Pro", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Make your own wizard newspaper.",
      "A yellowed, vintage, high-resolution front page of the 'Daily Prophet' newspaper, precisely matching the iconic visual style of the Harry Potter films. Prominently feature 'THE DAILY PROPHET' in its distinctive, ornate, gothic-inspired font at the top. A large, bold, impactful headline using a classic, slightly distressed serif font: 'BUTTERBEER FESTIVAL! AMOROUS CHOCOLATE!' A central black-and-white photo of joyful wizards clinking mugs.",
      [
        legacySeed("examples/nano-banana-pro/e4-1.webp"),
        legacySeed("examples/nano-banana-pro/e4-2.webp"),
        legacySeed("examples/nano-banana-pro/e4-3.webp"),
      ],
      [
        tool("Nano Banana Pro", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Generate professional engineering drawings.",
      "A professional CAD drawing of  this object. Isometric view, white lines on professional high quality blue background; line weights and line types follow conventions; add dimension lines and annotations.",
      [
        legacySeed("examples/nano-banana-pro/e5-1.webp"),
        legacySeed("examples/nano-banana-pro/e5-2.webp"),
        legacySeed("examples/nano-banana-pro/e5-3.webp"),
      ],
      [
        tool("Nano Banana Pro", legacySeed("icons/imagen-3.svg")),
        img("Image", legacySeed("inputs/nano-banana-pro/e5-input-1.webp")),
      ],
    ),
    ex(
      "Put your logo on everything.",
      "A vibrant and playful photo of a well-groomed woman's hand holding a banana-shaped bright yellow glossy popsicle by a classic popsicle stick, against a clear blue summer sky background. The subject is medium-sized in the composition, leaving plenty of empty space around. The hand has manicured nails painted in a matching yellow colour. The popsicle has this exact logo  debossed on it. A slightly low-angle, eye-level shot, looking up at the hand and the popsicle. The scene is illuminated by hard, direct, and high-contrast sunlight; strong, crisp, and well-defined shadows. It creates a graphic, bold, and energetic feel.",
      [
        legacySeed("examples/nano-banana-pro/e6-1.webp"),
        legacySeed("examples/nano-banana-pro/e6-2.webp"),
        legacySeed("examples/nano-banana-pro/e6-3.webp"),
      ],
      [
        tool("Nano Banana Pro", legacySeed("icons/imagen-3.svg")),
        img("Logo", legacySeed("inputs/common/loomic-logo.png")),
      ],
    ),
  ], "special"),
  cat("design", "Design", "Poster", [
    ex(
      "Design a Bauhaus-inspired poster.",
      "Make a poster for a music festival in the Bauhaus style. Use a limited color palette of pink, red, and cream. Abstract geometric shapes representing sound waves. Minimalist vertical text.",
      [
        legacySeed("examples/design/e1-1.webp"),
        legacySeed("examples/design/e1-2.webp"),
        legacySeed("examples/design/e1-3.webp"),
      ],
      [
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Design a ceramic dinnerware set.",
      "Generate a set of 5 images, each a ceramic tableware piece: 1 small bowl, 1 large bowl, 1 small plate, 1 large plate, 1 mug. They belong to the same set, harmoniously blends Scandinavian minimalism and Japanese wabi-sabi aesthetics - soft neutral tones, organic textures, imperfect hand-thrown forms, subtle glaze variations, natural lighting. Each piece is photographed against a seamless white background; even studio production photography lighting.",
      [
        legacySeed("examples/design/e2-1.webp"),
        legacySeed("examples/design/e2-2.webp"),
        legacySeed("examples/design/e2-3.webp"),
      ],
      [],
    ),
    ex(
      "Design new pieces for a jewelry collection.",
      "Generate product photos against a white background, 1 for earrings, 1 for a ring, belonging to the same set as the necklace. Make sure the design across the set is consistent. Maintain a cohesive visual tone suitable for a luxury brand website homepage - minimal, elegant, and timeless.",
      [
        legacySeed("examples/design/e3-1.webp"),
        legacySeed("examples/design/e3-2.webp"),
        legacySeed("examples/design/e3-3.webp"),
      ],
      [
        img("Necklace", legacySeed("inputs/design/e3-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Generate packaging design variations.",
      "Change the product packaging to cucumber flavor.",
      [
        legacySeed("examples/design/e4-1.webp"),
        legacySeed("examples/design/e4-2.webp"),
        legacySeed("examples/design/e4-3.webp"),
      ],
      [
        img("Cocoa Puffs", legacySeed("inputs/design/e4-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Experiment with furniture design.",
      "A velvet, bright orange sculptural tubular chair.",
      [
        legacySeed("examples/design/e5-1.webp"),
        legacySeed("examples/design/e5-2.webp"),
        legacySeed("examples/design/e5-3.webp"),
      ],
      [
        tool("Midjourney", legacySeed("icons/midjourney.svg")),
      ],
    ),
    ex(
      "Brainstorm beautiful interiors.",
      "Generate 5 different interiors - different furniture pieces, colors, space - in the same style and mood.",
      [
        legacySeed("examples/design/e6-1.webp"),
        legacySeed("examples/design/e6-2.webp"),
        legacySeed("examples/design/e6-3.webp"),
      ],
      [
        img("Interior", legacySeed("inputs/design/e6-input-1.webp")),
        tool("Gemini Imagen 4", legacySeed("icons/imagen-3.svg")),
      ],
    ),
  ]),
  cat("branding", "Branding", "Branding", [
    ex(
      "Generate logo options.",
      "Minimalist vector cartoon logo for a sushi shop. Use simple, bold, rounded lines. Very clean, modern, and well designed.",
      [
        legacySeed("examples/branding/e1-1.webp"),
        legacySeed("examples/branding/e1-2.webp"),
        legacySeed("examples/branding/e1-3.webp"),
      ],
      [
        tool("Gemini Imagen 4", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Design branded merch for your coffee shop.",
      "A minimalist product photo of a trendy high-quality ceramic espresso cup and saucer standing on a light wood surface against a clean white wall, with this logo printed in black on the cup. The scene is cinematic and editorial, illuminated by dramatic, warm afternoon light from the side, casting high contrast shadow. The composition is clean and organic. Sharp focus on the cup, warm color palette.",
      [
        legacySeed("examples/branding/e2-1.webp"),
        legacySeed("examples/branding/e2-2.webp"),
        legacySeed("examples/branding/e2-3.webp"),
      ],
      [
        img("Logo", legacySeed("inputs/common/loomic-logo.png")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Put your logo on a cap.",
      "Generate a studio product shot of a light blue cap featuring this logo embroidered on the front. The cap should appear realistic, well-lit, and minimal, placed on a neutral background. The embroidery should be in black thread, flat and subtle.",
      [
        legacySeed("examples/branding/e3-1.webp"),
        legacySeed("examples/branding/e3-2.webp"),
        legacySeed("examples/branding/e3-3.webp"),
      ],
      [
        img("Logo", legacySeed("inputs/common/loomic-logo.png")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Generate outdoor mockups for your design.",
      "Use  to make  the sidewalk board display  this exact ice cream image.",
      [
        legacySeed("examples/branding/e4-1.webp"),
        legacySeed("examples/branding/e4-2.webp"),
        legacySeed("examples/branding/e4-3.webp"),
      ],
      [
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
        img("Board", legacySeed("inputs/branding/e4-input-1.webp")),
        img("Image", legacySeed("inputs/branding/e4-input-2.webp")),
      ],
    ),
    ex(
      "Emotional storytelling for your brand.",
      "Generate the following images in the same mood and style for the same editorial series: closeup shot of a well-groomed hand fixing an earring; ultra closeup shot of a woman's foot in a stiletto stepping out of a car; closeup shot of the architectural detail of a curved luxuriant staircase; ultra close-up photo of an unmade bed; closeup shot of a delicate dessert in a fine dining restaurant.",
      [
        legacySeed("examples/branding/e5-1.webp"),
        legacySeed("examples/branding/e5-2.webp"),
        legacySeed("examples/branding/e5-3.webp"),
      ],
      [
        img("Reference", legacySeed("inputs/branding/e5-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Make a stunning holiday campaign for your brand.",
      "A flat-lay (overhead) product photograph featuring  this piece of jewelry. The jewelry is nestled within a bed of pristine white snow, sinking in deep and snugly. The snow shouldn't just be a flat base; it should rise up and partially bury the banana. The snow has a texture with small fine coarse ice crystals, creating a three-dimensional, coarse, powered sugar-like surface. The lighting is bright and direct, emphasizing the stark white of the snow and creating subtle micro-shadows that highlight its intricate, uneven texture.",
      [
        legacySeed("examples/branding/e6-1.webp"),
        legacySeed("examples/branding/e6-2.webp"),
        legacySeed("examples/branding/e6-3.webp"),
      ],
      [
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
        img("Earrings", legacySeed("inputs/branding/e6-input-1.webp")),
      ],
    ),
  ]),
  cat("illustration", "Illustration", "Illustration", [
    ex(
      "From sketch to endless illustration styles.",
      "Turn this sketch into a 2D illustration, try 5 different styles.",
      [
        legacySeed("examples/illustration/e1-1.webp"),
        legacySeed("examples/illustration/e1-2.webp"),
        legacySeed("examples/illustration/e1-3.webp"),
      ],
      [
        img("Cat", legacySeed("inputs/illustration/e1-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Turn your photo into an ink drawing.",
      "Turn this photo into a detailed ink drawing with fine lines and blue ink tones, drawn on a light grey dot grid notebook page. Maintain aspect ratio.",
      [
        legacySeed("examples/illustration/e2-1.webp"),
        legacySeed("examples/illustration/e2-2.webp"),
        legacySeed("examples/illustration/e2-3.webp"),
      ],
      [
        img("Image", legacySeed("inputs/illustration/e2-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Make surrealist art.",
      "Use these objects to generate a surrealist painting; use them however you like and however many times you like.",
      [
        legacySeed("examples/illustration/e3-1.webp"),
        legacySeed("examples/illustration/e3-2.webp"),
        legacySeed("examples/illustration/e3-3.webp"),
      ],
      [
        img("Spoon", legacySeed("inputs/illustration/e3-input-1.webp")),
        img("Umbrella", legacySeed("inputs/illustration/e3-input-2.webp")),
        img("Coca-Cola", legacySeed("inputs/illustration/e3-input-3.webp")),
        img("Egg", legacySeed("inputs/illustration/e3-input-4.webp")),
        img("Cherry", legacySeed("inputs/illustration/e3-input-5.webp")),
        img("Hat", legacySeed("inputs/illustration/e3-input-6.webp")),
        img("Box", legacySeed("inputs/illustration/e3-input-7.webp")),
        img("Stool", legacySeed("inputs/illustration/e3-input-8.webp")),
        img("Bunny", legacySeed("inputs/illustration/e3-input-9.webp")),
      ],
    ),
    ex(
      "Generate seamless patterns for your project.",
      "Generate 3 seamless ditsy floral patterns.",
      [
        legacySeed("examples/illustration/e4-1.webp"),
        legacySeed("examples/illustration/e4-2.webp"),
        legacySeed("examples/illustration/e4-3.webp"),
      ],
      [],
    ),
    ex(
      "Illustrate a photo in your signature style.",
      "Use  to generate a bold, colourful 2D indie illustration of this object  against a playful tablecloth pattern in the same style as  this drawing.",
      [
        legacySeed("examples/illustration/e5-1.webp"),
        legacySeed("examples/illustration/e5-2.webp"),
        legacySeed("examples/illustration/e5-3.webp"),
      ],
      [
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
        img("Avocado", legacySeed("inputs/illustration/e5-input-1.webp")),
        img("Reference", legacySeed("inputs/illustration/e5-input-2.webp")),
      ],
    ),
    ex(
      "Expand your illustration.",
      "Expand this illustration  and make the aspect ratio 16:9.",
      [
        legacySeed("examples/illustration/e6-1.webp"),
        legacySeed("examples/illustration/e6-2.webp"),
        legacySeed("examples/illustration/e6-3.webp"),
      ],
      [
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
        img("Image", legacySeed("inputs/illustration/e6-input-1.webp")),
      ],
    ),
  ]),
  cat("e-commerce", "E-Commerce", "Character", [
    ex(
      "Show your clothing on a model.",
      "Change her top to this sweater.",
      [
        legacySeed("examples/e-commerce/e1-1.webp"),
        legacySeed("examples/e-commerce/e1-2.webp"),
        legacySeed("examples/e-commerce/e1-3.webp"),
      ],
      [
        img("Model", legacySeed("inputs/e-commerce/e1-input-1.webp")),
        img("Sweater", legacySeed("inputs/e-commerce/e1-input-2.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Generate new angles for your clothing.",
      "Show me a back view and a side view of the model, maintain photography style.",
      [
        legacySeed("examples/e-commerce/e2-1.webp"),
        legacySeed("examples/e-commerce/e2-2.webp"),
        legacySeed("examples/e-commerce/e2-3.webp"),
      ],
      [
        img("Front View", legacySeed("inputs/e-commerce/e2-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Turn quick snapshots into polished product photos.",
      "Generate a series of five luxury haute jewelry fashion editorial photographs for a website showcasing this necklace.",
      [
        legacySeed("examples/e-commerce/e3-1.webp"),
        legacySeed("examples/e-commerce/e3-2.webp"),
        legacySeed("examples/e-commerce/e3-3.webp"),
      ],
      [
        img("Necklace", legacySeed("inputs/design/e3-input-1.webp")),
        tool("Seedream 4", legacySeed("icons/seedream_3.svg")),
      ],
    ),
    ex(
      "Style your product for social media.",
      "Generate 5 minimal, creative stylised lifestyle images for this ceramic dish, all in 4:5 aspect ratio.",
      [
        legacySeed("examples/e-commerce/e4-1.webp"),
        legacySeed("examples/e-commerce/e4-2.webp"),
        legacySeed("examples/e-commerce/e4-3.webp"),
      ],
      [
        img("Ceramic", legacySeed("inputs/e-commerce/e4-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Show your product in a lifestyle scene.",
      "Showcase this sofa in a clean, well decorated, cozy, modern, scandinavian interior with soft daylight and neutral material palette.",
      [
        legacySeed("examples/e-commerce/e5-1.webp"),
        legacySeed("examples/e-commerce/e5-2.webp"),
        legacySeed("examples/e-commerce/e5-3.webp"),
      ],
      [
        img("Sofa", legacySeed("inputs/e-commerce/e5-input-1.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
    ex(
      "Generate ad graphics for your product.",
      "A clean, minimalist, and modern ad poster for this perfume product. The bottle is centered in the lower half of the image. The background is a smooth vertical gradient that transitions from a light yellow at the bottom to a pastel bright butter yellow at the top. The poster includes the logo in white, and minimalist, small white sans serif text at the top: '20% Off Our Signature Scent'",
      [
        legacySeed("examples/e-commerce/e6-1.webp"),
        legacySeed("examples/e-commerce/e6-2.webp"),
        legacySeed("examples/e-commerce/e6-3.webp"),
      ],
      [
        img("Logo", legacySeed("inputs/common/loomic-logo.png")),
        img("Perfume", legacySeed("inputs/e-commerce/e6-input-2.webp")),
        tool("Nano Banana", legacySeed("icons/imagen-3.svg")),
      ],
    ),
  ]),
  cat("video", "Video", "Video", [
    ex(
      "Turn product photos into 360\u00b0 videos.",
      "Use this  as the start and end frame, generate a video of the ring rotating in slow motion.",
      [
        legacySeed("examples/design/e3-1.webp"),
        legacySeed("examples/design/e3-2.webp"),
        legacySeed("examples/design/e3-3.webp"),
      ],
      [
        tool("Kling 2.5 Turbo", legacySeed("icons/kling.svg")),
        img("Ring", legacySeed("inputs/video/e1-input-1.webp")),
      ],
    ),
    ex(
      "Turn static ads into scroll-stopping animations.",
      "Animate the perfume product while keeping the background completely still.",
      [
        legacySeed("examples/e-commerce/e6-1.webp"),
        legacySeed("examples/e-commerce/e6-2.webp"),
        legacySeed("examples/e-commerce/e6-3.webp"),
      ],
      [
        img("Poster", legacySeed("inputs/video/e2-input-1.webp")),
        tool("Kling 2.5 Turbo", legacySeed("icons/kling.svg")),
      ],
    ),
    ex(
      "Have your model walk.",
      "Have the model walk, the camera follows her.",
      [
        legacySeed("examples/video/e3-1.webp"),
        legacySeed("examples/video/e3-2.webp"),
        legacySeed("examples/video/e3-3.webp"),
      ],
      [
        img("Model", legacySeed("inputs/video/e3-input-1.webp")),
        tool("Kling 2.5 Turbo", legacySeed("icons/kling.svg")),
      ],
    ),
    ex(
      "Generate shortform videos with Sora, sound on.",
      "A vertical short-form ad for this exact product emphasising lifestyle and mood, with a grainy Kodak film quality. Montage of minimalist furniture details, flowers, butter and toast breakfast spread, sunlight through curtains, person spraying perfume into air. Soft lo-fi soundtrack, muted warm tones, seamless edit.",
      [
        legacySeed("examples/video/e4-1.webp"),
        legacySeed("examples/video/e4-2.webp"),
        legacySeed("examples/video/e4-3.webp"),
      ],
      [
        img("Perfume", legacySeed("inputs/e-commerce/e6-input-2.webp")),
        tool("Sora 2 Pro", legacySeed("icons/sora.svg")),
      ],
    ),
    ex(
      "Generate professional animation with Veo, sound on.",
      "Generate an 8-second animation using these two exact characters   in this exact  forest scene. A young princess twirls gracefully in the clearing as she meets a playful forest sprite named Finn. Together they discover a glowing magical flower, and swirling sparkles of light rise around them in wonder. The animation style should match a 1930s Disney cel fairy-tale film \u2014 expressive, rounded motion, warm painterly lighting, fluid hand-drawn animation feel, and soft orchestral background atmosphere. The voice and movement should evoke the tone of a classic Disney princess animation: gentle, melodic, full of warmth and wonder.",
      [
        legacySeed("examples/video/e5-1.webp"),
        legacySeed("examples/video/e5-2.webp"),
        legacySeed("examples/video/e5-3.webp"),
      ],
      [
        tool("Veo 3.1", legacySeed("icons/imagen-3.svg")),
        img("Princess Elara", legacySeed("inputs/video/e5-input-1.webp")),
        img("Forest Sprite", legacySeed("inputs/video/e5-input-2.webp")),
        img("Forest Clearing", legacySeed("inputs/video/e5-input-3.webp")),
      ],
    ),
    ex(
      "Generate cinematic footage.",
      "Generate a video. \u2014 AR 16:9 Low-angle shot of a sports car drifting through desert sand, dust plumes catching golden light. The camera tracks laterally with a long lens, heat haze shimmering in the distance. Fast-paced, grounded, kinetic.",
      [
        legacySeed("examples/video/e6-1.webp"),
        legacySeed("examples/video/e6-2.webp"),
        legacySeed("examples/video/e6-3.webp"),
      ],
      [],
    ),
  ]),
];

/**
 * The only way the seed data leaves this module: every image URL projected onto
 * the seed bucket, so the home page can never load a user-asset URL.
 */
export const homeExampleSeedCategories: HomeExampleCategory[] =
  rawHomeExampleSeedCategories.map(projectCategory);
