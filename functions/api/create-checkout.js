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


async function supabaseGet(
  env,
  path
) {

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json"
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
    : [];

}


async function createStripeCheckout(
  env,
  params
) {

  const body =
    new URLSearchParams();


  for (
    const [
      key,
      value
    ] of Object.entries(
      params
    )
  ) {

    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }

    body.append(
      key,
      String(value)
    );

  }


  const response =
    await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method:
          "POST",

        headers: {
          authorization:
            `Bearer ${env.STRIPE_SECRET_KEY}`,

          "content-type":
            "application/x-www-form-urlencoded"
        },

        body
      }
    );


  const text =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Stripe ${response.status}: ${text}`
    );

  }


  return JSON.parse(
    text
  );

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
      !env.STRIPE_SECRET_KEY ||
      !env.SITE_URL
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
    // READ REQUEST BODY
    // =====================================

    let body;


    try {

      body =
        await request.json();

    } catch {

      return json(
        {
          success: false,

          error:
            "Invalid request body."
        },
        400
      );

    }


    const playerSlug =
      String(
        body.player_slug ||
        ""
      ).trim();


    const anonymous =
      Boolean(
        body.anonymous
      );


    let donorName =
      String(
        body.donor_name ||
        ""
      ).trim();


    if (
      anonymous ||
      !donorName
    ) {

      donorName =
        "Anonymous";

    }


    let baseballs =
      Array.isArray(
        body.baseballs
      )
        ? body.baseballs
        : [];


    baseballs =
      [
        ...new Set(
          baseballs
            .map(
              Number
            )
            .filter(
              number =>
                Number.isInteger(
                  number
                ) &&
                number >= 1 &&
                number <= 60
            )
        )
      ].sort(
        (a,b) =>
          a - b
      );


    if (
      !playerSlug
    ) {

      return json(
        {
          success: false,

          error:
            "Missing player."
        },
        400
      );

    }


    if (
      !baseballs.length
    ) {

      return json(
        {
          success: false,

          error:
            "Select at least one baseball."
        },
        400
      );

    }


    // =====================================
    // FIND TEAM
    // =====================================

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.${encodeURIComponent(
          TEAM_KEY
        )}&select=id,team_key,team_name&limit=1`
      );


    if (
      !teams.length
    ) {

      return json(
        {
          success: false,

          error:
            "Team not found."
        },
        404
      );

    }


    const team =
      teams[0];


    // =====================================
    // FIND PLAYER
    // =====================================

    let players =
      await supabaseGet(
        env,
        `players?team_id=eq.${encodeURIComponent(
          team.id
        )}&slug=eq.${encodeURIComponent(
          playerSlug
        )}&select=id,slug,player_key,name,player_name,player_number&limit=1`
      );


    if (
      !players.length
    ) {

      players =
        await supabaseGet(
          env,
          `players?team_id=eq.${encodeURIComponent(
            team.id
          )}&player_key=eq.${encodeURIComponent(
            playerSlug
          )}&select=id,slug,player_key,name,player_name,player_number&limit=1`
        );

    }


    if (
      !players.length
    ) {

      return json(
        {
          success: false,

          error:
            "Player not found."
        },
        404
      );

    }


    const player =
      players[0];


    const playerName =
      player.player_name ||
      player.name;


    const playerNumber =
      player.player_number;


    // =====================================
    // CHECK IF SELECTED BASEBALLS
    // ARE ALREADY SOLD
    // =====================================

    const ballList =
      baseballs.join(
        ","
      );


    const soldBalls =
      await supabaseGet(
        env,
        `baseballs?team_id=eq.${encodeURIComponent(
          TEAM_KEY
        )}&player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${ballList})&status=eq.sold&select=ball_number`
      );


    if (
      soldBalls.length
    ) {

      const unavailableBalls =
        soldBalls
          .map(
            item =>
              Number(
                item.ball_number
              )
          )
          .sort(
            (a,b) =>
              a - b
          );


      return json(
        {
          success: false,

          error:
            "One or more selected baseballs are no longer available.",

          unavailableBalls
        },
        409
      );

    }


    // =====================================
    // TOTAL DONATION
    // =====================================

    const totalDollars =
      baseballs.reduce(
        (
          total,
          ball
        ) =>
          total + ball,
        0
      );


    const totalCents =
      totalDollars *
      100;


    // =====================================
    // SUCCESS / CANCEL URLS
    // =====================================

    const siteUrl =
      String(
        env.SITE_URL
      ).replace(
        /\/+$/,
        ""
      );


    const successUrl =
      `${siteUrl}/fundraiser.html?player=${encodeURIComponent(
        playerSlug
      )}&payment=success&session_id={CHECKOUT_SESSION_ID}`;


    const cancelUrl =
      `${siteUrl}/fundraiser.html?player=${encodeURIComponent(
        playerSlug
      )}&payment=cancelled`;


    // =====================================
    // STRIPE CHECKOUT SESSION
    // =====================================

    const checkout =
      await createStripeCheckout(
        env,
        {

          mode:
            "payment",

          success_url:
            successUrl,

          cancel_url:
            cancelUrl,


          "line_items[0][quantity]":
            1,


          "line_items[0][price_data][currency]":
            "usd",


          "line_items[0][price_data][unit_amount]":
            totalCents,


          "line_items[0][price_data][product_data][name]":
            `${playerName} - Road to Pigeon Forge`,


          "line_items[0][price_data][product_data][description]":
            `West Boynton Travel baseball fundraiser — Baseball${baseballs.length === 1 ? "" : "s"} #${baseballs.join(", #")}`,


          "metadata[donation_type]":
            "baseballs",

          "metadata[team_key]":
            TEAM_KEY,

          "metadata[player_id]":
            player.id,

          "metadata[player_slug]":
            playerSlug,

          "metadata[player_name]":
            playerName,

          "metadata[player_number]":
            playerNumber,

          "metadata[baseballs]":
            baseballs.join(
              ","
            ),

          "metadata[donor_name]":
            donorName,

          "metadata[anonymous]":
            anonymous
              ? "true"
              : "false",

          "metadata[amount_dollars]":
            totalDollars,

          "metadata[amount_cents]":
            totalCents,


          "payment_intent_data[metadata][donation_type]":
            "baseballs",

          "payment_intent_data[metadata][team_key]":
            TEAM_KEY,

          "payment_intent_data[metadata][player_id]":
            player.id,

          "payment_intent_data[metadata][player_slug]":
            playerSlug,

          "payment_intent_data[metadata][player_name]":
            playerName,

          "payment_intent_data[metadata][player_number]":
            playerNumber,

          "payment_intent_data[metadata][baseballs]":
            baseballs.join(
              ","
            ),

          "payment_intent_data[metadata][donor_name]":
            donorName,

          "payment_intent_data[metadata][anonymous]":
            anonymous
              ? "true"
              : "false"

        }
      );


    if (
      !checkout.url
    ) {

      throw new Error(
        "Stripe did not return a checkout URL."
      );

    }


    // =====================================
    // RESPONSE
    // =====================================

    return json({
      success: true,

      url:
        checkout.url,

      session_id:
        checkout.id,

      player: {
        id:
          player.id,

        slug:
          playerSlug,

        name:
          playerName,

        number:
          playerNumber
      },

      baseballs,

      amount:
        totalDollars,

      amount_cents:
        totalCents
    });

  } catch (
    error
  ) {

    console.error(
      "West Boynton create checkout error:",
      error
    );


    return json(
      {
        success: false,

        error:
          "Unable to create checkout.",

        details:
          error.message
      },
      500
    );

  }

}
