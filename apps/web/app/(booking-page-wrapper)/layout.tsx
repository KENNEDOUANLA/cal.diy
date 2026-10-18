import Image from "next/image";
import { Figtree } from "next/font/google";
import "./gesticarros-booking.css";
import { headers } from "next/headers";

import PageWrapper from "@components/PageWrapperAppDir";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-gesticarros", display: "swap" });

export default async function BookingPageWrapperLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const nonce = h.get("x-csp-nonce") ?? undefined;

  return (
    <>
      <PageWrapper isBookingPage={true} requiresLicense={false} nonce={nonce}>
        <div className={`gc-booking ${figtree.variable}`}>
          <header className="gc-booking-header">
            <a href="https://gesticarros.com" aria-label="GestiCarros">
              <Image
                src="/gesticarros-logo.png"
                alt="GestiCarros"
                width={156}
                height={40}
                priority
                className="gc-booking-logo"
              />
            </a>
          </header>
          <div className="gc-booking-content">{children}</div>
        </div>
      </PageWrapper>
    </>
  );
}
