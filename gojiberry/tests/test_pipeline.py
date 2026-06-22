import pytest

from pipeline.dedupe import dedupe
from pipeline.normalize import (
    classify_intent,
    IntentHTMLParser,
    parse_location,
    split_name,
    normalize_row,
)
from pipeline.personalize import personalize_row


def test_intent_html_extracts_post_url():
    html = "Just engaged with a <a href='https://www.linkedin.com/feed/update/urn:li:activity:123/' target='_blank'>LinkedIn post</a>"
    p = IntentHTMLParser()
    p.feed(html)
    intent = classify_intent(html, p)
    assert intent["post_url"] == "https://www.linkedin.com/feed/update/urn:li:activity:123/"
    assert intent["intent_type"] == "linkedin_post"


def test_author_post_intent():
    html = "Just engaged with a post written by <a href='https://linkedin.com/in/jane'>Jane Doe</a>"
    p = IntentHTMLParser()
    p.feed(html)
    intent = classify_intent(html, p)
    assert intent["intent_type"] == "author_post"


def test_split_credentials():
    name, cred = split_name("Bucci, CFBE")
    assert name == "Bucci"
    assert cred == "CFBE"


def test_split_jr_suffix():
    name, cred = split_name("Calderon Jr.")
    assert "Calderon" in name


def test_location_metro():
    loc = parse_location("Denver Metropolitan Area, United States")
    assert loc["is_metro"] is True
    assert loc["country"] == "United States"


def test_dedupe_by_name_company():
    a = {"first_name": "Riley", "clean_last_name": "Greenwood", "company": "Hampton", "profile_resolved": True, "profile_url": "https://linkedin.com/in/a"}
    b = {**a}
    unique, dupes = dedupe([a, b])
    assert len(unique) == 1
    assert len(dupes) == 1


def test_template_branching_differs_by_intent():
    base = {
        "first_name": "Vincent",
        "company": "AAHOA",
        "seniority_tier": "manager",
        "intent_keyword": "hotel operations",
        "profile_resolved": True,
    }
    lookalike = personalize_row({**base, "intent_type": "lookalike"})
    hired = personalize_row({**base, "intent_type": "just_hired"})
    assert lookalike["email_message"] != hired["email_message"]
    assert lookalike["template_intent"] == "lookalike"
    assert hired["template_intent"] == "just_hired"


def test_no_fake_post_url():
    row = normalize_row({
        "First Name": "Test",
        "Last Name": "User",
        "Intent": "Lookalike match: Similar to your ideal lead",
        "Job Title": "GM",
        "Company": "Hotel X",
        "Industry": "Hospitality",
        "Location": "United States",
        "Profile URL": "https://linkedin.com/in/test",
        "Total Score": "2.0",
    })
    msg = personalize_row(row)
    assert "linkedin.com/feed" not in msg["email_message"]
