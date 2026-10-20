// Flight Sector's rails for every customer. They run in the platform's egress
// before the traveller's company is asked: a forbid here ends the request, and
// a permit only lets it on to the company's Person Server, which still decides.

@id("search")
permit (principal, action == Action::"booking.search", resource);

@id("quote")
permit (principal, action == Action::"booking.quote", resource);

@id("reserve")
permit (principal, action == Action::"booking.reserve", resource);

@id("cancel")
permit (principal, action == Action::"booking.cancel", resource);

@id("missionless-cancel")
@reason("a booking is cancelled only under the trip it was booked for")
forbid (principal, action == Action::"booking.cancel", resource)
unless { context has mission };

@id("missionless-booking")
@reason("propose the trip first: a booking needs the traveller's approved mission")
forbid (principal, action == Action::"booking.reserve", resource)
unless { context has mission };

// Refused at the quote too, so a trip in first is never proposed to a manager.
@id("no-first-class")
@reason("first class is never booked: quote business or economy instead")
forbid (principal, action in [Action::"booking.quote", Action::"booking.reserve"], resource)
when { resource has cabin && resource.cabin == "first" };

@id("business-by-seniority")
@reason("business class on the company's account needs the company's seniority, on a leg of six hours or more")
forbid (principal, action == Action::"booking.reserve", resource)
when { resource has cabin && resource.cabin == "business" && resource.payer == "company" }
unless {
  principal has level && principal has company &&
  principal.level >= principal.company.business_min_level &&
  resource has block_minutes && resource.block_minutes >= 360
};

@id("over-seniority-limit")
@reason("this booking costs more than the traveller's seniority allows on the company's account")
forbid (principal, action == Action::"booking.reserve", resource)
when {
  resource.payer == "company" && resource has total_cents &&
  principal has level && principal has company &&
  principal.company has booking_limit_cents &&
  principal.company has senior_booking_limit_cents &&
  resource.total_cents >
    (if principal.level >= principal.company.business_min_level
     then principal.company.senior_booking_limit_cents
     else principal.company.booking_limit_cents)
};

@id("asked-for")
@reason("Jev could not confirm this booking is what the traveller asked for")
forbid (principal, action == Action::"booking.reserve", resource)
unless {
  context has judgement && context.judgement has requested &&
  context.judgement.requested >= 50
};

@id("personal-is-the-travellers")
@reason("a personal booking is paid by the traveller")
forbid (principal, action == Action::"booking.reserve", resource)
when {
  resource.payer == "company" &&
  (resource.purpose == "personal" ||
   (context has judgement && context.judgement has personal &&
    context.judgement.personal >= 70))
};

@id("propose")
permit (principal, action == Action::"mission.propose", resource);

@id("complete")
permit (principal, action == Action::"mission.complete", resource);

@id("proposed-as-asked")
@reason("the proposed trip is not the one the traveller asked for: propose their destination, dates and budget")
forbid (principal, action == Action::"mission.propose", resource)
unless {
  context has judgement && context.judgement has requested &&
  context.judgement.requested >= 50
};
