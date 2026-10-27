"""Offline estimate; no credentials, network, or production data. USD, decimal GB.

Run: python3 specs/045-catalog-r2-images/cost-model.py > /tmp/catalog-r2-estimate.json
Daily cohorts: 750 creations at day start; first update after 12h, then every 12h.
Daily peak storage follows R2 billing. Reads are an explicit external-consumer
assumption, not a consequence of writing a feed or assigning a URL.
"""

import json
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP


D = Decimal
USERS = 50
CREATES_PER_USER_DAY = 15
PRODUCTS = 100
IMAGE_MB = D("0.2")
POOL_PER_USER = 500
VIDEO_MB = D("100")
PER_DAY = USERS * CREATES_PER_USER_DAY
POOL_OBJECTS = USERS * POOL_PER_USER
POOL_GB = POOL_OBJECTS * IMAGE_MB / 1000


def ceil(value):
    return D(value).to_integral_value(rounding=ROUND_CEILING)


def money(value):
    return float(D(value).quantize(D("0.01"), rounding=ROUND_HALF_UP))


def bill(storage_gb, writes, reads, free_tier=True):
    free_s, free_a, free_b = (10, 1_000_000, 10_000_000) if free_tier else (0, 0, 0)
    storage = max(D(0), ceil(storage_gb) - free_s) * D("0.015")
    a = ceil(max(D(0), D(writes) - free_a) / 1_000_000) * D("4.50")
    b = ceil(max(D(0), D(reads) - free_b) / 1_000_000) * D("0.36")
    return {"storage": money(storage), "class_a": money(a), "class_b": money(b),
            "total": money(storage + a + b)}


def month(m, video_mb=VIDEO_MB):
    start, end = (m - 1) * 30, m * 30
    days = range(start + 1, end + 1)
    creates = PER_DAY * 30
    updates = PER_DAY * (end * end - start * start)
    cycles = creates + updates
    pool_writes = POOL_OBJECTS if m == 1 else 0
    video_gb = D(video_mb) / 1000
    latest_gb = sum(D(PER_DAY * day) * video_gb for day in days) / 30
    versions_gb = sum(D(PER_DAY * (day * day + day)) * video_gb for day in days) / 30
    # A seven-day optional pause keeps metadata/media; no automatic deletion.
    paused_updates = sum(PER_DAY * min(2 * day - 1, 14) for day in days)
    paused_cycles = creates + paused_updates
    image_reads = cycles * PRODUCTS
    media_reads = cycles * (PRODUCTS + 1)
    media_egress_gb = D(cycles) * (PRODUCTS * IMAGE_MB / 1000 + video_gb)
    storage = POOL_GB + latest_gb
    # Provider comparison uses identical conservative average storage for all.
    b2_storage = max(D(0), storage - 10) * D("0.00695")
    b2_egress = max(D(0), media_egress_gb - 3 * storage) * D("0.01")
    bunny_storage = max(D(1), storage * D("0.01"))
    supabase_storage = max(D(0), storage - 100) * D("0.0213")
    return {
        "month": m, "catalogs_end": PER_DAY * end,
        "updates": updates, "cycles_including_creation": cycles,
        "image_reads_before_cache": image_reads,
        "latest_video_gb_end": float(PER_DAY * end * video_gb),
        "latest_video_gb_month": float(latest_gb),
        "all_video_versions_gb_end": float(PER_DAY * (end * end + end) * video_gb),
        "all_video_versions_gb_month": float(versions_gb),
        "video_upload_gb_month": float(cycles * video_gb),
        "consumer_media_egress_gb": float(media_egress_gb),
        "local_hours_at_20_seconds_per_restitch": money(D(cycles) * 20 / 3600),
        "r2_images_creation_reads_only": bill(POOL_GB, pool_writes, creates * PRODUCTS),
        "r2_images_every_cycle": bill(POOL_GB, pool_writes, image_reads),
        "r2_images_every_cycle_90pct_cache": bill(POOL_GB, pool_writes, D(image_reads) / 10),
        "r2_images_every_cycle_99pct_cache": bill(POOL_GB, pool_writes, D(image_reads) / 100),
        "r2_video_creation_only": bill(storage, creates + pool_writes, media_reads),
        "r2_video_every_cycle_latest": bill(storage, cycles + pool_writes, media_reads),
        "r2_video_every_cycle_latest_99pct_image_cache": bill(
            storage, cycles + pool_writes, D(image_reads) / 100 + cycles),
        "r2_video_every_cycle_all_versions": bill(POOL_GB + versions_gb, cycles + pool_writes, media_reads),
        "r2_video_latest_without_free_tier": bill(storage, cycles + pool_writes, media_reads, False),
        "r2_optional_pause_7d_keep_latest_forever": bill(
            storage, paused_cycles + pool_writes, paused_cycles * (PRODUCTS + 1)),
        "r2_optional_pause_7d_paused_cycles": paused_cycles,
        "comparative_latest_video_cold": {
            "b2_direct": money(b2_storage + b2_egress),
            "b2_storage_only_partner_delivery_extra": money(b2_storage),
            "bunny_europe_na": money(bunny_storage + media_egress_gb * D("0.01")),
            "supabase_cached": money(supabase_storage + max(D(0), media_egress_gb - 250) * D("0.03")),
            "supabase_uncached": money(supabase_storage + max(D(0), media_egress_gb - 250) * D("0.09")),
        },
    }


if __name__ == "__main__":
    months = [month(m) for m in range(1, 13)]
    print(json.dumps({
        "as_of": "2026-10-27", "currency": "USD", "days_per_month": 30,
        "assumptions": {"users": USERS, "creates_per_user_day": CREATES_PER_USER_DAY,
                        "products_per_catalog": PRODUCTS, "pool_images_per_user": POOL_PER_USER,
                        "image_mb": float(IMAGE_MB), "video_mb": float(VIDEO_MB),
                        "pool_gb": float(POOL_GB), "updates_per_day": 2,
                        "consumer_fetches_per_row_per_cycle": 1,
                        "cache_hit_ratio_default": 0, "single_put_per_upload": True},
        "months": months,
        "year_total": {key: money(sum(D(str(row[key]["total"])) for row in months))
                       for key in ["r2_images_every_cycle", "r2_video_creation_only",
                                   "r2_video_every_cycle_latest", "r2_video_every_cycle_all_versions"]},
        "video_size_sensitivity_month_12": {
            str(size): month(12, D(size))["r2_video_every_cycle_latest"]
            for size in [25, 50, 100, 200, 500]
        },
    }, indent=2, ensure_ascii=False))
