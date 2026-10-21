import { redirect } from "next/navigation";

/** BL-40: subscription plans are retired; the old pricing URL sends people home. */
export default function PricingPage(): never {
  redirect("/home");
}
