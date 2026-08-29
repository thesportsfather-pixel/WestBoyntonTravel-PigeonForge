const TEAM_KEY = "west-boynton-travel";
const GOAL_AMOUNT = 1830;

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


export async function onRequestGet({
  request,
  env
}) {

  try {

    // =====================================
    // REQUIRED ENVIRONMENT VARIABLES
    // =====================================

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
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
    // GET PLAYER SLUG
    // =====================================

    const url =
      new URL(
        request.url
      );


    const playerSlug =
      String(
        url.searchParams.get(
          "player"
        ) || ""
      ).trim();


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


    // =====================================
    // FIND TEAM
    // =====================================

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.${encodeURIComponent(
          TEAM_KEY
        )}&select=id,team_key,team_name,primary_color,secondary_color&limit=1`
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


    // fallback to player_key if needed
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


    // =====================================
    // SOLD BASEBALLS
    // =====================================

    const soldBalls =
      await supabaseGet(
        env,
        `baseballs?team_id=eq.${encodeURIComponent(
          TEAM_KEY
        )}&player_id=eq.${encodeURIComponent(
          player.id
        )}&status=eq.sold&select=ball_number,donor_name,sold_at,stripe_session_id&order=ball_number.asc`
      );


    // =====================================
    // BASEBALL TOTAL
    // =====================================

    const baseballAmountRaised =
      soldBalls.reduce(
        (
          total,
          ball
        ) => {

          return (
            total +
            Number(
              ball.ball_number ||
              0
            )
          );

        },
        0
      );


    // =====================================
    // GENERAL DONATIONS
    // =====================================

    let generalOrders =
      [];


    try {

      generalOrders =
        await supabaseGet(
          env,
          `orders?team_id=eq.${encodeURIComponent(
            TEAM_KEY
          )}&player_id=eq.${encodeURIComponent(
            player.id
          )}&donation_type=eq.general&status=eq.paid&select=amount_cents,total_cents,amount`
        );

    } catch (
      error
    ) {

      console.error(
        "Unable to load general donations:",
        error
      );

      generalOrders =
        [];

    }


    // =====================================
    // GENERAL DONATION TOTAL
    // =====================================

    const generalDonationAmount =
      generalOrders.reduce(
        (
          total,
          order
        ) => {

          if (
            Number(
              order.amount_cents
            ) > 0
          ) {

            return (
              total +
              Number(
                order.amount_cents
              ) / 100
            );

          }


          if (
            Number(
              order.total_cents
            ) > 0
          ) {

            return (
              total +
              Number(
                order.total_cents
              ) / 100
            );

          }


          if (
            Number(
              order.amount
            ) > 0
          ) {

            return (
              total +
              Number(
                order.amount
              )
            );

          }


          return total;

        },
        0
      );


    // =====================================
    // TOTAL RAISED
    // =====================================

    const amountRaised =
      baseballAmountRaised +
      generalDonationAmount;


    const progressPercent =
      Math.min(
        100,
        Math.max(
          0,
          (
            amountRaised /
            GOAL_AMOUNT
          ) * 100
        )
      );


    // =====================================
    // RESPONSE
    // =====================================

    return json({
      success: true,

      team: {
        id:
          team.id,

        team_key:
          team.team_key,

        team_name:
          team.team_name,

        primary_color:
          team.primary_color,

        secondary_color:
          team.secondary_color
      },

      player: {
        id:
          player.id,

        slug:
          player.slug ||
          player.player_key,

        player_key:
          player.player_key,

        name:
          player.player_name ||
          player.name,

        player_name:
          player.player_name ||
          player.name,

        player_number:
          player.player_number
      },

      soldBalls,

      soldCount:
        soldBalls.length,

      baseballAmountRaised,

      generalDonationAmount,

      amountRaised,

      goalAmount:
        GOAL_AMOUNT,

      progressPercent
    });

  } catch (
    error
  ) {

    console.error(
      "West Boynton fundraiser API error:",
      error
    );


    return json(
      {
        success: false,

        error:
          "Unable to load fundraiser.",

        details:
          error.message
      },
      500
    );

  }

}
