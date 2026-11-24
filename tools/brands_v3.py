"""brands_v3.py – candidate brands for brand model v3 (non-packaging brands that appear in influencer videos).

Why these brands (24 Nov):
  1. Brands Gemini named in OUR stored analyses (public/data/*.json + tests/ergebnisse, counted with a script): Apple, Sonos,
     LG, Peak Design, Canon, Bose, LEGO, Keychron, DJI, Volvo, BMW, Google, Sennheiser, Samsung, Seagate, Razer, ASUS,
     Beats, Bowers & Wilkins, Nothing, Volkswagen, Audi, Gaggia, Sage, Trek, Under Armour, Guess, Zara, H&M, Dyson,
     Logitech, Philips Hue, Nanoleaf, Focusrite, RØDE, beyerdynamic, Edifier, NZXT, CalDigit, Continental, SRAM,
     RockShox, Rose, Alpina, Head, Louis Vuitton, Yves Saint Laurent, Kapten & Son … → every one of them is a candidate.
  2. Well-known rankings of the categories that tech, fashion, sport, home and car channels show most: Interbrand Best
     Global Brands (tech, apparel, luxury, automotive), the German "Markenranking" lists (Bosch, Miele, Adidas, Puma,
     Jack Wolfskin …), the classic YouTube niches (desk setups, "what's in my bag", EDC, coffee, home office, cycling,
     outdoor, sneakers, watches, cars).
  3. Only brands with a visible logo or a recognisable product look; store chains and groups are left out.
A brand becomes a class only if Wikimedia Commons (+ Open Products Facts) gives it at least 20 usable photos
(tools/build_brand_data_v3.py); candidates with 8–19 photos become FOREIGN brands for the false-alarm test.

Entry: "Name"  or  ("Name", "extra search words or -exclusions", ["other title words that count as this brand"])
The search always requires the brand (or one of the other title words) in the FILE TITLE (intitle:), so a photo of a
puma, a mango or the Patagonia region does not end up as a brand photo.
"""

BRANDS = {
    "tech": [
        ("Apple", "", ["iPhone", "MacBook", "iPad", "AirPods", "iMac", "Mac mini", "Apple Watch", "Magic Keyboard", "HomePod"]),
        "Samsung", "Sony", "Bose", "Sonos", "Logitech", "Keychron", "DJI", "GoPro", "Anker", "Razer", "Elgato",
        ("Nintendo", "", ["Nintendo Switch", "Game Boy"]), ("PlayStation", "", ["DualSense", "DualShock"]),
        ("Xbox", "", []), "Microsoft Surface", "Google Pixel", ("Google Nest", "", ["Nest Hub", "Chromecast"]),
        "Lenovo", ("Dell", "computer OR laptop OR monitor OR XPS", []), ("Hewlett-Packard", "", ["HP laptop", "HP printer", "HP EliteBook", "HP Pavilion"]),
        "Asus", "Acer", ("MSI", "laptop OR graphics OR motherboard", []), ("LG", "monitor OR TV OR phone OR OLED OR UltraFine", ["LG Electronics"]),
        "Philips Hue", "Nanoleaf", "Sennheiser", "JBL", ("Marshall", "amplifier OR speaker OR headphones OR amp", []),
        "Bang & Olufsen", "Bowers & Wilkins", "Beyerdynamic", "Audio-Technica", "Shure", ("Røde", "microphone", ["Rode NT", "Rode Podmic", "Rode VideoMic"]),
        "Focusrite", "Teenage Engineering", "Edifier", "Garmin", "Fitbit", ("Polar", "watch OR heart", []), "Suunto",
        ("Kindle", "", ["Amazon Echo", "Fire TV"]), "Xiaomi", "Huawei", "OnePlus", "Oppo", "Realme", "Motorola", "Nokia",
        "Fairphone", ("Nothing Phone", "", ["Nothing Ear"]), ("Canon", "camera OR EOS OR lens OR PowerShot", []), "Nikon", "Fujifilm", "Panasonic Lumix",
        "Leica", "Olympus", "Sigma", "Tamron", ("Insta360", "", []), "Corsair", "SteelSeries", "HyperX", "Turtle Beach",
        "Nvidia", "AMD Ryzen", "Intel Core", "Raspberry Pi", "Arduino", "Western Digital", "Seagate", "SanDisk", "Samsung SSD",
        "Synology", "Netgear", "TP-Link", "AVM Fritz", "Ubiquiti", "Wacom", "reMarkable", "Kobo", "Tolino", "Tonies",
        "Teufel", "Ultimate Ears", "Marantz", "Yamaha", "Denon", "Technics", "Pioneer", "Roland", "Korg", "Fender", "Gibson",
        "Moog", "Native Instruments", "Akai", "Behringer", "Blackmagic", "Atomos", "Zoom H", "Peak Design", "Moment",
        "Elgato Stream Deck", "Belkin", "Satechi", "Twelve South", "CalDigit", "Ugreen", "Baseus", "Philips", "Braun",
        "Tile", "Ring doorbell", "Arlo", "Eufy", "Roomba", "Roborock", "Ecovacs", "Tesla", "Oculus", "Meta Quest", "Steam Deck",
        "Casio", "Texas Instruments", "Brother", "Epson", "Canon Pixma", "Kodak", "Polaroid", "Instax", "Leatherman", "Victorinox",
        "Zippo", "Maglite", "Ledlenser", "Fenix", "Olight", "Nitecore", "Quntis", "BenQ", "ViewSonic", "AOC", "Eizo", "Herman Miller",
        "Secretlab", "Grovemade", "Divoom", "NZXT", "Cooler Master", "be quiet!", "Noctua", "Thermaltake", "Lian Li", "Fractal Design",
        "Ducky", "Varmilo", "Glorious", "Wooting", "Zowie", "Lofree", "Nuphy", "Das Keyboard", "Cherry", "Bitdefender",
    ],
    "fashion": [
        "Nike", "Adidas", ("Puma", "-concolor -cougar -animal -zoo", ["Puma shoes", "Puma SE"]), "Reebok", "New Balance", "Asics",
        ("Vans", "shoe OR shoes OR sneaker OR store", ["Vans Old Skool", "Vans Authentic"]), ("Converse", "shoe OR shoes OR sneaker OR Chuck", ["Chuck Taylor"]),
        "Under Armour", "Fila", "Champion", "Kappa", "Umbro", "Lacoste", "Ralph Lauren", "Tommy Hilfiger", "Calvin Klein",
        "Hugo Boss", "Levi's", "Wrangler", "Lee jeans", "Diesel jeans", ("Guess", "store OR jeans OR bag", []), "Zara", "H&M", "Uniqlo",
        "Primark", "C&A", "Esprit", "s.Oliver", "Marc O'Polo", "Abercrombie", "Hollister", "Superdry",
        "The North Face", ("Patagonia", "jacket OR store OR clothing OR fleece", ["Patagonia Inc"]), ("Columbia Sportswear", "", []),
        "Carhartt", "Dickies", "Stüssy", "Supreme", "Palace Skateboards", "Off-White", "Balenciaga", "Gucci", "Prada",
        "Louis Vuitton", "Chanel", "Hermès", "Dior", "Burberry", "Versace", "Fendi", "Givenchy", "Yves Saint Laurent",
        "Moncler", "Canada Goose", "Stone Island", "Arc'teryx", "Barbour", "Timberland", "Dr. Martens", "Birkenstock",
        "Crocs", "UGG", "Clarks", "Ecco", "Salomon", "Hoka", "On Running", "Veja", "Allbirds", "Skechers", "Saucony",
        "Brooks Running", "Mizuno", "Onitsuka Tiger", "Jordan", ("Air Max", "", ["Air Force 1", "Air Jordan"]),
        ("Ray-Ban", "", ["Wayfarer"]), ("Oakley", "sunglasses OR glasses", []), "Persol", "Carrera", "Maui Jim",
        ("Casio G-Shock", "", ["G-Shock"]), "Rolex", ("Omega", "watch OR Speedmaster OR Seamaster", []), "Tissot", "Swatch", "Seiko",
        "Citizen", "TAG Heuer", "Breitling", "Cartier", "Patek Philippe", "Audemars Piguet", "Hublot", "Longines",
        "Junghans", "Nomos", "Sinn", "Daniel Wellington", "Fossil", "Michael Kors", "Kate Spade", "Coach handbag",
        "Tory Burch", "Longchamp", "Goldwheat", "Pandora jewelry", "Swarovski", "Tiffany & Co", "Kapten & Son", "Fjällräven",
        "Herschel", "Eastpak", "Jansport", "Samsonite", "Rimowa", "Tumi", "Osprey", "Deuter", "Bellroy", "Ridge wallet",
        "Away luggage", "Montblanc", "Lamy", "Moleskine", "Leuchtturm1917", "Pelikan", "Faber-Castell", "Parker pen",
    ],
    "sport_outdoor": [
        "Jack Wolfskin", "Vaude", "Mammut", "Ortovox", "Schöffel", "Haglöfs", "Helly Hansen", "Columbia", "Marmot",
        "Black Diamond", "Petzl", "Mountain Hardwear", "Rab", "Salewa", "La Sportiva", "Lowa", "Meindl", "Hanwag", "Merrell",
        "Keen", "Teva", "Chaco", "Yeti cooler", "Stanley", "Hydro Flask", "Nalgene", "Klean Kanteen", "Thermos", "Sigg",
        "Camelbak", "Coleman", "MSR", "Jetboil", "Primus", "Trangia", "Hilleberg", "Nordisk", "Exped", "Therm-a-Rest",
        "Big Agnes", "Decathlon", "Quechua", "Wilson", ("Head", "racket OR ski OR tennis", []), "Babolat", "Yonex",
        "Spalding", "Molten", "Mikasa", "Uhlsport", "Jako", "Hummel", "Erima", "Speedo", "Arena swimwear", "Garmin Edge",
        "Wahoo", "Peloton", "Concept2", "Technogym", "Kettler", "Trek", "Specialized", "Cannondale", "Giant bicycle", "Scott",
        "Canyon", "Cube", "Rose Bikes", "Bianchi", "Pinarello", "Cervélo", "Santa Cruz", "Orbea", "Brompton", "VanMoof",
        "Cowboy bike", "Riese & Müller", "Gazelle", "Shimano", "SRAM", "Campagnolo", "RockShox", "Fox Racing", "Continental tyre",
        "Schwalbe", "Michelin", "Pirelli", "Bosch eBike", "Brooks saddle", "Ortlieb", "Topeak", "Abus", "Kryptonite", "Uvex",
        "Giro", "Bell helmet", "POC", "Alpina", "Oakley helmet", "Burton", "K2", "Atomic", "Rossignol", "Fischer ski",
        "Völkl", "Elan", "Blizzard", "Dynafit", "Leki", "Komperdell", "Red Bull", "GoPro Hero", "Rip Curl", "Quiksilver",
        "Billabong", "O'Neill", "Element skateboards", "Santa Cruz skateboards", "Thrasher",
    ],
    "home_kitchen": [
        "IKEA", "Dyson", "Bosch", "Siemens", "Miele", "AEG", "Neff", "Gaggenau", "Liebherr", "Smeg", "Kitchenaid",
        "Kenwood", "Krups", "Tefal", "Rowenta", "Moulinex", "Russell Hobbs", "WMF", "Fissler", "Zwilling", "Le Creuset",
        "Staub", "Lodge cast iron", "Thermomix", "Vorwerk", "Nespresso", "Jura", "De'Longhi", "Breville", "Sage appliances",
        "Gaggia", "Rancilio", "La Marzocco", "Rocket Espresso", "Lelit", "ECM", "Bialetti", "Melitta", "Tchibo", "Moccamaster",
        "Chemex", "Hario", "AeroPress", "Fellow", "Comandante", "Baratza", "Eureka grinder", "Wilfa", "Ninja", "Instant Pot",
        "Vitamix", "Nutribullet", "Weber grill", "Napoleon grill", "Big Green Egg", "Traeger", "Ooni", "SodaStream", "Brita",
        "Tupperware", "Emsa", "Villeroy & Boch", "Rosenthal", "Iittala", "Arabia", "Bodum", "Alessi", "Joseph Joseph",
        "OXO", "Kärcher", "Vileda", "Leifheit", "Gardena", "Stihl", "Husqvarna", "Makita", "DeWalt", "Festool", "Hilti",
        "Metabo", "Fein", "Milwaukee tool", "Ryobi", "Black & Decker", "Einhell", "Wera", "Knipex", "Wiha", "Fischer dowel",
        "Tesa", "Vitra", "USM Haller", "Hay design", "Muuto", "Fritz Hansen", "Louis Poulsen", "Artemide", "Flos", "Kartell",
        "String furniture", "Montana furniture", "Bang & Olufsen Beosound", "Nest thermostat", "Tado", "Netatmo", "Eve Systems",
        "Govee", "Yankee Candle", "Diptyque", "Le Labo", "Aesop", "Kiehl's", "Lush", "The Body Shop", "Rituals", 
        "Glossier", "Fenty Beauty", "Rare Beauty", "Benefit", "MAC Cosmetics", "Clinique", "Estée Lauder",
        "Lancôme", "Shiseido", "La Mer", "Charlotte Tilbury", "Huda Beauty", "Too Faced", "Urban Decay", "NARS", "Bobbi Brown",
        "Tom Ford", "Jo Malone", "Creed", "Byredo", "Oral-B", "Philips Sonicare", "Gillette", "Wilkinson", "Remington", "GHD", "BaByliss",
        "Foreo", "Theragun", "LEGO", "Playmobil", "Schleich", "Ravensburger", "Hasbro", "Mattel", "Barbie", "Hot Wheels",
        "Funko", "Pokémon", "Steiff", "Haba", "Brio", "Carrera slot", "Märklin", "Revell", "Kosmos", "Monopoly", "Catan",
    ],
    "auto_mobility": [
        "BMW", "Mercedes-Benz", "Audi", "Volkswagen", "Porsche", "Opel", "Ford", "Volvo", "Toyota", "Honda", "Nissan", "Mazda",
        "Hyundai", "Kia", "Tesla Model", "Renault", "Peugeot", "Citroën", "Fiat", "Alfa Romeo", "Ferrari", "Lamborghini",
        "Maserati", "Jeep", "Land Rover", "Range Rover", "Jaguar car", "Mini Cooper", "Smart Fortwo", "Seat", "Cupra", "Skoda",
        "Dacia", "Subaru", "Suzuki", "Mitsubishi", "Lexus", "Polestar", "BYD", "Rivian", "Lucid", "Bentley", "Rolls-Royce",
        "Aston Martin", "McLaren", "Bugatti", "Ducati", "Harley-Davidson", "KTM", "Kawasaki", "Yamaha motorcycle", "Vespa",
        "Piaggio", "Triumph motorcycle", "BMW Motorrad", "Niu scooter", "Segway", "Xiaomi scooter", "Lime scooter", "Tier scooter",
        "Thule", "Recaro", "Cybex", "Maxi-Cosi", "Britax", "Bugaboo", "Joolz", "Stokke", "Michelin tyre", "Bridgestone",
        "Goodyear", "Dunlop", "Hankook", "Bosch car", "Osram", "Hella", "Castrol",
    ],
    "german": [
        "Haribo", "Ritter Sport", "Milka", "Kinder", "Nivea", "Tempo", "Uhu", "Edding", "Stabilo", "Staedtler", "Schwan-Stabilo",
        "Herlitz", "Pelikan", "Leitz", "Tchibo", "Rotring", "Melitta", "Würth", "Puky", "Kettler bike",
        "Scout Schulranzen", "Ergobag", "Satch", "Bree", "Liebeskind", "Tamaris", "Gabor", "Rieker", "Lloyd shoes", "Bogner",
        "Escada", "Jil Sander", "Closed", "Armedangels", "Hessnatur", "Trigema", "Falke", "Schiesser", "Mey", "Seidensticker",
        "Olymp", "Eterna", "Camel Active", "Bugatti fashion", "Strellson", "Joop", "Drykorn", "Wellensteyn", "Napapijri",
        "Engelbert Strauss", "Leica camera", "Zeiss", "Steinway", "Sennheiser MD", "Neumann", "Grundig", "Loewe", "Blaupunkt",
        "Teufel Raumfeld", "Medion", "Tonies Toniebox", "Sigikid", "Nici", "Käthe Kruse", "Rotkäppchen", "Jägermeister",
        "Beck's", "Krombacher", "Bitburger", "Warsteiner", "Paulaner", "Erdinger", "Augustiner", "Radeberger", "Club-Mate",
        "Fritz-Kola", "Bionade", "Afri-Cola", "Haribo Goldbären",
    ],
}


def entries():
    """[(name, extra_query, title_words, category)] without duplicates (first category wins)"""
    out, seen = [], set()
    for cat, lst in BRANDS.items():
        for e in lst:
            name, extra, alt = (e, "", []) if isinstance(e, str) else e
            extra = EXTRA.get(name, extra)
            k = name.lower()
            if k in seen or name in DROP:
                continue
            seen.add(k)
            out.append((name, extra, alt, cat))
    return out


# brands whose search name carries a helper word ("Coach handbag") → class name without it
DISPLAY = {"Mango store": "Mango", "Gap store": "Gap", "Coach handbag": "Coach", "Lee jeans": "Lee", "Diesel jeans": "Diesel",
           "Giant bicycle": "Giant", "Continental tyre": "Continental", "Bosch eBike": "Bosch", "Brooks saddle": "Brooks England",
           "Bell helmet": "Bell", "Oakley helmet": "Oakley", "Fischer ski": "Fischer", "GoPro Hero": "GoPro", "Garmin Edge": "Garmin",
           "Yeti cooler": "Yeti", "Arena swimwear": "Arena", "Lodge cast iron": "Lodge", "Sage appliances": "Sage",
           "Eureka grinder": "Eureka", "Weber grill": "Weber", "Napoleon grill": "Napoleon", "Milwaukee tool": "Milwaukee",
           "Fischer dowel": "Fischer", "Hay design": "HAY", "String furniture": "String", "Montana furniture": "Montana",
           "Bang & Olufsen Beosound": "Bang & Olufsen", "Nest thermostat": "Google Nest", "Philips Sonicare": "Philips",
           "Carrera slot": "Carrera", "Tesla Model": "Tesla", "Jaguar car": "Jaguar", "Mini Cooper": "Mini", "Smart Fortwo": "Smart",
           "Yamaha motorcycle": "Yamaha", "Triumph motorcycle": "Triumph", "BMW Motorrad": "BMW", "Niu scooter": "NIU",
           "Xiaomi scooter": "Xiaomi", "Lime scooter": "Lime", "Tier scooter": "Tier", "Michelin tyre": "Michelin", "Bosch car": "Bosch",
           "Shell station": "Shell", "Kettler bike": "Kettler", "Scout Schulranzen": "Scout", "Lloyd shoes": "Lloyd",
           "Bugatti fashion": "Bugatti", "Leica camera": "Leica", "Sennheiser MD": "Sennheiser", "Teufel Raumfeld": "Teufel",
           "Tonies Toniebox": "Tonies", "Haribo Goldbären": "Haribo", "Samsung SSD": "Samsung", "Canon Pixma": "Canon",
           "Elgato Stream Deck": "Elgato", "Ring doorbell": "Ring", "Steam Deck": "Steam Deck", "Zoom H": "Zoom",
           "Pandora jewelry": "Pandora", "Ridge wallet": "Ridge", "Away luggage": "Away", "Parker pen": "Parker",
           "Casio G-Shock": "Casio", "Air Max": "Nike", "Jordan": "Nike", "Microsoft Surface": "Microsoft", "Google Pixel": "Google",
           "Google Nest": "Google", "AMD Ryzen": "AMD", "Intel Core": "Intel", "Panasonic Lumix": "Panasonic", "AVM Fritz": "AVM",
           "Nothing Phone": "Nothing", "Kindle": "Amazon", "Meta Quest": "Meta", "Oculus": "Meta", "Hewlett-Packard": "HP",
           "Schwan-Stabilo": "Stabilo", "Sennheiser": "Sennheiser", "Instax": "Fujifilm", "Columbia Sportswear": "Columbia",
           "Santa Cruz skateboards": "Santa Cruz", "Range Rover": "Land Rover", "Philips Hue": "Philips Hue", "Roomba": "iRobot"}


# Ambiguous names: the search additionally needs one of these words somewhere on the file page (OR group), so
# "Acer platanoides", an osprey, the astronomer Herschel or a "lush" landscape are not taken as brand photos.
_S = "shoe OR shoes OR sneaker OR sneakers OR boot OR store"
_F = "store OR boutique OR bag OR handbag OR fashion OR shop OR perfume OR shoe OR watch"
EXTRA = {
    "Puma": _S + " OR jersey OR jacket OR shirt", "Nike": "-Samothrace -goddess -statue -missile -Nikephoros", "Fila": _S + " OR shirt OR jacket",
    "Champion": "hoodie OR sweatshirt OR shirt OR clothing OR jacket", "Kappa": "clothing OR jacket OR shirt OR football OR jersey",
    "Lacoste": "shirt OR polo OR store OR shoe OR shoes OR bag", "Ralph Lauren": _F + " OR polo OR shirt", "Tommy Hilfiger": _F + " OR shirt OR jacket",
    "Calvin Klein": _F + " OR underwear OR jeans OR billboard", "Hugo Boss": _F + " OR suit", "Wrangler": "jeans OR denim OR clothing",
    "Esprit": "store OR fashion OR clothing OR shop", "Zara": "store OR shop OR fashion OR clothing", "Hollister": "store OR clothing OR shop",
    "Dickies": "pants OR work OR store OR clothing OR shirt", "Supreme": "store OR clothing OR box OR shop OR hoodie",
    "Balenciaga": _F, "Gucci": _F + " OR belt", "Chanel": _F + " OR No", "Hermès": _F + " OR Birkin OR Kelly", "Dior": _F, "Versace": _F,
    "Givenchy": _F, "Yves Saint Laurent": _F, "Louis Vuitton": "-Fondation -foundation", "Canada Goose": "jacket OR parka OR store OR coat",
    "Stone Island": "jacket OR clothing OR store OR badge", "Barbour": "jacket OR store OR wax", "Timberland": "boot OR boots OR shoe OR store",
    "Crocs": "shoe OR shoes OR clog OR store OR sandal", "Clarks": _S, "Ecco": _S, "Salomon": _S + " OR ski OR running", "Hoka": _S + " OR running",
    "Veja": _S, "Mizuno": _S + " OR running OR golf OR glove", "Tissot": "watch OR store", "Seiko": "watch OR clock OR store",
    "Breitling": "watch OR store OR Navitimer", "Cartier": "watch OR store OR jewelry OR boutique OR bracelet OR Tank",
    "Junghans": "watch OR clock OR Uhr", "Daniel Wellington": "watch", "Michael Kors": "bag OR handbag OR store OR watch OR purse",
    "Kate Spade": "bag OR handbag OR store OR purse", "Tory Burch": "store OR bag OR shoe OR flats", "Longchamp": "bag OR handbag OR Pliage OR store",
    "Fjällräven": "backpack OR Kånken OR Kanken OR jacket OR bag OR store", "Herschel": "backpack OR bag OR Supply",
    "Tumi": "bag OR backpack OR luggage OR suitcase OR store", "Osprey": "backpack OR pack OR bag", "Deuter": "backpack OR rucksack OR bag OR tent",
    "Montblanc": "pen OR watch OR store OR Meisterstück OR fountain", "Lamy": "pen OR fountain OR Safari OR pencil",
    "Faber-Castell": "pencil OR pen OR crayon OR pencils", "Fossil": "watch OR store OR bag", "Citizen": "watch", "Sinn": "watch OR Uhr",
    "Nomos": "watch OR Glashütte", "Bose": "headphones OR speaker OR QuietComfort OR SoundLink OR Wave OR earbuds",
    "Anker": "charger OR power OR battery OR cable OR Soundcore OR USB", "Acer": "laptop OR computer OR monitor OR Aspire OR Predator OR Chromebook OR notebook",
    "Olympus": "camera OR OM OR PEN OR lens OR Stylus OR Zuiko", "Sigma": "lens OR camera OR fp", "Corsair": "keyboard OR mouse OR case OR headset OR memory OR PC",
    "Turtle Beach": "headset OR headphones", "reMarkable": "tablet OR paper", "Braun": "shaver OR razor OR toothbrush OR radio OR design OR coffee OR kitchen OR clock OR calculator",
    "Tile": "tracker OR Bluetooth", "Arlo": "camera", "Fenix": "flashlight OR torch OR lamp", "AOC": "monitor", "Noctua": "fan OR cooler OR NH",
    "Lian Li": "case OR PC", "Ducky": "keyboard", "Glorious": "mouse OR keyboard", "Zowie": "mouse OR monitor", "Cherry": "keyboard OR switch OR switches",
    "Moment": "lens OR case", "Roland": "synthesizer OR keyboard OR drum OR piano OR sampler", "Moog": "synthesizer", "Gibson": "guitar",
    "Fender": "guitar OR amplifier OR bass OR Stratocaster OR Telecaster", "Pioneer": "DJ OR CDJ OR audio OR receiver OR speaker OR turntable",
    "Teufel": "speaker OR lautsprecher OR Lautsprecher", "Kobo": "reader OR ereader OR eReader", "Brother": "printer OR sewing OR typewriter OR label",
    "Mammut": "jacket OR backpack OR rope OR store OR outdoor", "Columbia": "jacket OR sportswear OR store", "Marmot": "jacket OR tent OR backpack",
    "Rab": "jacket OR down", "Giro": "helmet", "POC": "helmet OR goggles", "K2": "ski OR skates OR snowboard", "Elan": "ski OR skis",
    "Atomic": "ski OR skis OR boot", "Blizzard": "ski OR skis", "Canyon": "bike OR bicycle", "Specialized": "bike OR bicycle",
    "Trek": "bike OR bicycle OR Madone OR Domane", "Santa Cruz": "bike OR bicycle OR Bronson OR Nomad", "Gazelle": "bike OR bicycle OR fiets",
    "Cube": "bike OR bicycle", "Scott": "bike OR bicycle OR ski", "Abus": "lock OR helmet", "Kryptonite": "lock", "Wilson": "ball OR racket OR tennis OR football OR basketball",
    "Spalding": "ball OR basketball", "Molten": "ball", "Mikasa": "ball OR volleyball", "Hummel": "jersey OR shirt OR kit OR football OR shoe",
    "Peloton": "bike OR treadmill OR Tread", "Stanley": "cup OR thermos OR bottle OR mug OR tumbler OR flask", "Sigg": "bottle",
    "Coleman": "lantern OR stove OR tent OR cooler", "MSR": "stove OR tent", "Nordisk": "tent", "Quechua": "tent OR backpack OR jacket",
    "Burton": "snowboard OR jacket OR store", "Thrasher": "magazine OR shirt OR hoodie", "Billabong": "surf OR clothing OR store OR board",
    "O'Neill": "wetsuit OR surf OR jacket", "Siemens": "appliance OR dishwasher OR washing OR oven OR fridge OR kitchen OR phone OR vacuum OR Gigaset",
    "AEG": "appliance OR oven OR washing OR kettle OR vacuum OR drill OR toaster", "Neff": "oven OR kitchen OR hob",
    "Liebherr": "fridge OR refrigerator OR freezer OR Kühlschrank", "Ninja": "blender OR kitchen OR fryer OR appliance",
    "Fellow": "kettle OR coffee OR grinder", "Comandante": "grinder OR coffee", "Rosenthal": "porcelain OR cup OR vase OR plate",
    "Arabia": "porcelain OR cup OR tableware OR mug OR plate", "OXO": "kitchen OR tool OR container OR Good Grips",
    "Gardena": "hose OR garden OR sprinkler OR tool", "Fein": "tool OR MultiMaster OR grinder OR drill", "Wera": "tool OR screwdriver OR wrench",
    "Vitra": "chair OR furniture OR stool OR lamp", "Flos": "lamp OR light", "Aesop": "store OR shop OR soap OR cosmetics OR skincare",
    "Lush": "store OR shop OR cosmetics OR soap OR bath", "Rituals": "store OR cosmetics OR shop", "Benefit": "cosmetics OR makeup OR store",
    "Clinique": "cosmetics OR store OR makeup", "La Mer": "cream OR cosmetics OR skincare", "Urban Decay": "cosmetics OR makeup OR palette OR store",
    "NARS": "cosmetics OR makeup OR store", "Tom Ford": "store OR perfume OR sunglasses OR fragrance", "Jo Malone": "store OR perfume OR fragrance OR candle",
    "Creed": "perfume OR fragrance OR Aventus", "Gillette": "razor OR store OR shaving", "Wilkinson": "razor OR blade OR shaving",
    "Remington": "shaver OR razor OR trimmer OR typewriter OR hair", "GHD": "hair OR straightener", "Schleich": "figure OR toy OR animal",
    "Ravensburger": "puzzle OR game OR toy", "Pokémon": "card OR toy OR plush OR figure OR game OR Center", "Haba": "toy", "Brio": "toy OR train",
    "Kosmos": "kit OR experiment OR game", "Ford": "car OR Mustang OR Focus OR Fiesta OR Transit OR Ranger OR Model OR Taunus OR Escort",
    "Porsche": "-Ferdinand", "Seat": "car OR Ibiza OR Leon OR Ateca OR Arona OR Toledo", "Dacia": "car OR Duster OR Sandero OR Logan OR Spring",
    "Suzuki": "car OR motorcycle OR Swift OR Jimny OR Vitara OR GSX", "Bentley": "car OR Continental OR Bentayga OR Mulsanne",
    "McLaren": "car OR 720S OR P1 OR MP4 OR 570S OR Senna", "Kawasaki": "motorcycle OR Ninja OR ZX OR Versys OR Vulcan",
    "Thule": "box OR rack OR bag OR backpack OR roof OR carrier", "Bridgestone": "tire OR tyre OR tires OR tyres",
    "Goodyear": "tire OR tyre OR tires OR tyres OR blimp", "Dunlop": "tire OR tyre OR racket OR tennis OR ball", "Hankook": "tire OR tyre",
    "Osram": "lamp OR bulb OR light OR tube", "Hella": "lamp OR headlight OR light", "Tempo": "Taschentuch OR tissue OR tissues OR Taschentücher",
    "Uhu": "glue OR Kleber OR Klebstoff", "Edding": "marker OR Stift", "Pelikan": "pen OR fountain OR ink OR Füller OR Souverän",
    "Satch": "backpack OR school OR Schulrucksack", "Bree": "bag", "Liebeskind": "bag OR handbag", "Tamaris": _S, "Gabor": _S, "Rieker": _S,
    "Bogner": "ski OR jacket OR fashion OR store", "Olymp": "shirt OR Hemd", "Falke": "socks OR sock OR Socken OR clothing",
    "Neumann": "microphone OR mic", "Käthe Kruse": "doll OR Puppe", "Rotkäppchen": "Sekt OR sparkling OR wine OR bottle",
    "Augustiner": "beer OR Bier OR Bräu OR bottle", "Radeberger": "beer OR Bier OR Pilsner", "Nici": "plush OR toy OR Plüsch",
    "Polar": "watch OR heart OR Vantage", "Keen": "shoe OR shoes OR sandal OR boot", "Lowa": "boot OR shoe OR shoes", "Primus": "stove OR Kocher",
    "Brita": "filter OR jug", "Tesa": "tape OR film OR Klebeband", "Decathlon": "store OR shop", "Steiff": "bear OR teddy OR toy OR plush",
    "Red Bull": "can OR drink OR Dose", "Lucid": "Air OR car", "Mitsubishi": "car OR Lancer OR Pajero OR Outlander OR Colt OR Eclipse",
}
DROP = {"Jordan", "Off-White", "Goldwheat", "Carrera", "Carrera slot", "Eterna", "Loewe", "Closed", "Mey", "Bitdefender", "Tesla"}
