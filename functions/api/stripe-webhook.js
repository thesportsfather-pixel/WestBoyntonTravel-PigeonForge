const TEAM_KEY = "west-boynton-travel";


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}


async function verifyStripeSignature(
  payload,
  signature,
  secret
) {

  if (
    !signature ||
    !secret
  ) {
    return false;
  }


  const parts =
    signature.split(",");


  const timestampPart =
    parts.find(
      part =>
        part.startsWith("t=")
    );


  const signatureParts =
    parts
      .filter(
        part =>
          part.startsWith("v1=")
      )
      .map(
        part =>
          part.slice(3)
      );


  if (
    !timestampPart ||
    !signatureParts.length
  ) {
    return false;
  }


  const timestamp =
    timestampPart.slice(2);


  const signedPayload =
    `${timestamp}.${payload}`;


  const encoder =
    new TextEncoder();


  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );


  const signatureBuffer =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(
        signedPayload
      )
    );


  const generatedSignature =
    [...new Uint8Array(
      signatureBuffer
    )]
      .map(
        byte =>
          byte
            .toString(16)
            .padStart(2, "0")
      )
      .join("");


  return signatureParts.includes(
    generatedSignature
  );

}


async function supabaseRequest(
  env,
  path,
  options = {}
) {

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "content-type":
            "application/json",

          prefer:
            options.prefer ||
            "return=representation",

          ...(options.headers || {})
        }
      }
    );


  const text =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Supabase ${response.status}: ${text}`
    );

  }


  return text
    ? JSON.parse(text)
    : null;

}


export async function onRequestPost({
  request,
  env
}) {

  try {

    // =====================================
    // REQUIRED ENVIRONMENT VARIABLES
    // =====================================

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_WEBHOOK_SECRET
    ) {

      return json(
        {
          success: false,
          error:
            "Missing server configuration."
        },
        500
      );

    }


    // =====================================
    // VERIFY STRIPE SIGNATURE
    // =====================================

    const payload =
      await request.text();


    const stripeSignature =
      request.headers.get(
        "stripe-signature"
      );


    const validSignature =
      await verifyStripeSignature(
        payload,
        stripeSignature,
        env.STRIPE_WEBHOOK_SECRET
      );


    if (
      !validSignature
    ) {

      return json(
        {
          success: false,
          error:
            "Invalid Stripe signature."
        },
        400
      );

    }


    const event =
      JSON.parse(
        payload
      );


    // =====================================
    // ONLY HANDLE COMPLETED CHECKOUT
    // =====================================

    if (
      event.type !==
      "checkout.session.completed"
    ) {

      return json({
        success: true,
        ignored: true,
        event_type:
          event.type
      });

    }


    const session =
      event.data?.object;


    if (
      !session
    ) {

      return json({
        success: true,
        ignored: true
      });

    }


    // =====================================
    // ONLY PROCESS PAID CHECKOUTS
    // =====================================

    if (
      session.payment_status !==
      "paid"
    ) {

      return json({
        success: true,
        ignored: true,
        reason:
          "Checkout not paid."
      });

    }


    const metadata =
      session.metadata || {};


    // =====================================
    // PROTECT OTHER TEAM FUNDRAISERS
    // =====================================

    if (
      metadata.team_key !==
      TEAM_KEY
    ) {

      return json({
        success: true,
        ignored: true,
        reason:
          "Different team."
      });

    }


    const donationType =
      String(
        metadata.donation_type ||
        ""
      ).trim();


    const playerId =
      String(
        metadata.player_id ||
        ""
      ).trim();


    const playerSlug =
      String(
        metadata.player_slug ||
        ""
      ).trim();


    const playerName =
      String(
        metadata.player_name ||
        ""
      ).trim();


    const playerNumber =
      Number(
        metadata.player_number ||
        0
      );


    const donorName =
      String(
        metadata.donor_name ||
        "Anonymous"
      ).trim() ||
      "Anonymous";


    const anonymous =
      String(
        metadata.anonymous ||
        "false"
      ) === "true";


    const amountCents =
      Number(
        metadata.amount_cents ||
        session.amount_total ||
        0
      );


    const amountDollars =
      Number(
        metadata.amount_dollars ||
        (
          amountCents / 100
        )
      );


    if (
      !playerId
    ) {

      throw new Error(
        "Missing player_id metadata."
      );

    }


    // =====================================
    // BASIC IDEMPOTENCY CHECK
    // =====================================

    const existingOrders =
      await supabaseRequest(
        env,
        `orders?stripe_session_id=eq.${encodeURIComponent(
          session.id
        )}&select=id&limit=1`,
        {
          method:
            "GET"
        }
      );


    if (
      Array.isArray(
        existingOrders
      ) &&
      existingOrders.length
    ) {

      return json({
        success: true,
        already_processed: true
      });

    }


    // =====================================
    // BASEBALL DONATION
    // =====================================

    if (
      donationType ===
      "baseballs"
    ) {

      const baseballs =
        String(
          metadata.baseballs ||
          ""
        )
          .split(",")
          .map(
            value =>
              Number(
                value.trim()
              )
          )
          .filter(
            number =>
              Number.isInteger(
                number
              ) &&
              number >= 1 &&
              number <= 60
          );


      if (
        !baseballs.length
      ) {

        throw new Error(
          "No valid baseballs found in Stripe metadata."
        );

      }


      // ---------------------------------
      // MARK EACH BASEBALL SOLD
      // ---------------------------------

      for (
        const ballNumber of baseballs
      ) {

        await supabaseRequest(
          env,
          `baseballs?team_id=eq.${encodeURIComponent(
            TEAM_KEY
          )}&player_id=eq.${encodeURIComponent(
            playerId
          )}&ball_number=eq.${ballNumber}&status=neq.sold`,
          {
            method:
              "PATCH",

            body:
              JSON.stringify({
                status:
                  "sold",

                donor_name:
                  donorName,

                sold_at:
                  new Date()
                    .toISOString(),

                stripe_session_id:
                  session.id,

                reserved_until:
                  null,

                reservation_id:
                  null
              })
          }
        );

      }


      // ---------------------------------
      // SAVE PAID ORDER
      // ---------------------------------

      await supabaseRequest(
        env,
        "orders",
        {
          method:
            "POST",

          body:
            JSON.stringify({
              team_id:
                TEAM_KEY,

              player_id:
                playerId,

              donation_type:
                "baseballs",

              status:
                "paid",

              stripe_session_id:
                session.id,

              amount_cents:
                amountCents,

              amount:
                amountDollars,

              donor_name:
                donorName,

              anonymous:
                anonymous,

              baseballs:
                baseballs.join(","),

              player_slug:
                playerSlug,

              player_name:
                playerName,

              player_number:
                playerNumber
            })
        }
      );


      return json({
        success: true,
        donation_type:
          "baseballs",
        baseballs
      });

    }


    // =====================================
    // GENERAL DONATION
    // =====================================

    if (
      donationType ===
      "general"
    ) {

      await supabaseRequest(
        env,
        "orders",
        {
          method:
            "POST",

          body:
            JSON.stringify({
              team_id:
                TEAM_KEY,

              player_id:
                playerId,

              donation_type:
                "general",

              status:
                "paid",

              stripe_session_id:
                session.id,

              amount_cents:
                amountCents,

              amount:
                amountDollars,

              donor_name:
                donorName,

              anonymous:
                anonymous,

              player_slug:
                playerSlug,

              player_name:
                playerName,

              player_number:
                playerNumber
            })
        }
      );


      return json({
        success: true,
        donation_type:
          "general"
      });

    }


    // =====================================
    // UNKNOWN DONATION TYPE
    // =====================================

    return json({
      success: true,
      ignored: true,
      reason:
        "Unknown donation type."
    });

  } catch (
    error
  ) {

    console.error(
      "West Boynton Stripe webhook error:",
      error
    );


    return json(
      {
        success: false,

        error:
          "Webhook processing failed.",

        details:
          error.message
      },
      500
    );

  }

}
